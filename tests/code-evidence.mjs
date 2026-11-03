import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanCodeEvidence } from '../dist/shell/archify/code-evidence.js';
import { applyCodeLayers } from '../dist/archify/code-evidence.js';
import { mapBootstrapNext, mapBootstrapSubmit } from '../dist/shell/archify/map-bootstrap.js';
import { FileProjectArchitectureSource } from '../dist/architecture-source.js';
import { archReviewGenerator } from '../dist/core/maintenance/arch-review.js';
import { maintenanceGenerators } from '../dist/core/maintenance/registry.js';
import { structureFingerprint, gapCheckFingerprint } from '../dist/core/maintenance/structure-fingerprint.js';
import { createTestRoot } from './test-isolation.mjs';
import { handleMemoryControlRead } from '../dist/memory-control-http.js';

test('on-demand evidence read is project-scoped and reports partial coverage without declaring old refs stale', async () => {
  const current = 'code:alpha:aaaaaaaaaaaa:src/a.ts#L1-L1';
  const old = 'code:alpha:bbbbbbbbbbbb:src/b.ts#L2-L2';
  const foreign = 'code:other:bbbbbbbbbbbb:src/secret.ts#L1-L1';
  let scans = 0;
  const runtime = { accountId: 'acct', projects: { async list() { return []; }, async resolve(_account, ref) { return ref === 'alpha' ? 'alpha' : undefined; } },
    architecture: { async inspectProjectCodeEvidence(identity) { scans++; assert.deepEqual(identity, { accountId: 'acct', projectId: 'alpha' });
      return { snapshot: { revision: 'aaaaaaaaaaaa', commit: 'abc', truncated: ['output_limit'], items: [{ kind: 'module', ref: current }] },
        files: [{ path: 'src/a.ts', hash: 'hash' }] }; },
      async inspectProjectCognitiveMap() { return { map: { nodes: [{ evidence_refs: [current, old, foreign] }], edges: [] } }; },
      async getProjectCodeCitations({ refs }) { assert.deepEqual(refs, [current, old]); return [{ ref: old, kind: 'dependency', snippet: 'src/b.ts -> src/a.ts' }]; } } };
  const read = async (project, role = 'admin', callerAccountId = 'acct') => {
    let status, body; const response = { setHeader() {}, writeHead(value) { status = value; return this; }, end(value) { body = JSON.parse(value); } };
    await handleMemoryControlRead({ response, url: new URL('http://local/?kind=code_evidence' + (project ? '&project=' + project : '')),
      stateRoot: '', runtime, accounts: [], selectedAccount: { account_id: 'acct', role }, callerAccountId, adminView: false });
    return { status, body };
  };
  assert.equal((await read('other')).status, 404);
  assert.equal((await read('')).status, 400);
  assert.equal((await read('alpha', 'user')).status, 403);
  assert.equal((await read('alpha', 'admin', 'foreign')).status, 403);
  assert.equal(scans, 0);
  const result = await read('alpha');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.truncated, ['output_limit']);
  assert.deepEqual(result.body.emitted, { module: 1, dependency: 0, constant: 0, layer: 0 });
  assert.equal(result.body.references_total, 2);
  assert.deepEqual(result.body.files, [{ path: 'src/a.ts', hash: 'hash' }]);
  assert.equal(result.body.citations[0].status, 'same_snapshot');
  assert.equal(result.body.citations[1].status, 'different_or_unscanned');
  assert.equal(result.body.citations[1].item.snippet, 'src/b.ts -> src/a.ts');
  assert.doesNotMatch(JSON.stringify(result.body), /secret\.ts/);
});

test('on-demand file hashes detect content changes without changing the snapshot contract', async t => {
  const { repo, put } = await fixture(t, { 'src/core/a.ts': 'export const LIMIT = 1;\n', 'src/core/b.ts': 'export const LIMIT = 8;\n' });
  const firstFiles = new Map(), secondFiles = new Map();
  const first = await scanCodeEvidence(repo, 'alpha', (path, hash) => firstFiles.set(path, hash));
  assert.deepEqual(first, await scanCodeEvidence(repo, 'alpha'));
  await put('src/core/a.ts', 'export const LIMIT = 2;\n');
  await scanCodeEvidence(repo, 'alpha', (path, hash) => secondFiles.set(path, hash));
  assert.notEqual(firstFiles.get('src/core/a.ts'), secondFiles.get('src/core/a.ts'));
  assert.equal(firstFiles.get('src/core/b.ts'), secondFiles.get('src/core/b.ts'));
  assert.match(firstFiles.get('src/core/a.ts'), /^[a-f0-9]{64}$/);
});

const rules = { layers: [{name:'core',paths:['src/core/**']},{name:'shell',paths:['src/shell/**']}], allowed:{core:[],shell:['core']} };
async function fixture(t, files = {}) {
  const root = await createTestRoot('code-evidence-');
  t.after(() => rm(root, {recursive:true,force:true}));
  const repo = join(root,'alpha');
  const put = async (path, text) => { await mkdir(dirname(join(repo,path)),{recursive:true}); await writeFile(join(repo,path),text); };
  await put('ARCHITECTURE.md','# Alpha\nAlpha has a bounded capture module.\n');
  await put('.memhub/layers.json',JSON.stringify(rules,null,2));
  for (const [path,text] of Object.entries(files)) await put(path,text);
  return {root,repo,put};
}
const git = (repo,...args) => execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const moduleRefs = snap => snap.items.filter(item=>item.kind==='module');
const candidate = refs => ({nodes:[{id:'alpha',kind:'project',label:'Alpha',summary:'Alpha',parent_id:null,order:0,evidence_refs:[refs[0]],confidence:.9},
  {id:'capture',kind:'capability',label:'Capture',summary:'Bounded capture',parent_id:'alpha',order:1,evidence_refs:refs,confidence:.9}],edges:[],timeline_links:[]});

test('scanner extracts literal TS/JS/config evidence without comments, expressions or secret values',async t=>{
  const {repo}=await fixture(t,{
    'src/core/capture.ts':"// export const FAKE_LIMIT = 99;\nconst text = 'export const STRING_LIMIT = 88;';\nexport const TOP_K: number = 8;\nexport const MAX_SECRET = 'do-not-emit';\nexport const MAX_DYNAMIC = 2 + 3;\nimport { item } from '../shell/input.js';\n",
    'settings.json':JSON.stringify({max_size:32,password_limit:'never-visible',nested:{timeout:12},other:'hidden'}),
    'config.yaml':'limit: 16\nsecret:\n  max_size: never-visible\n',
    'settings.toml':'timeout = 45\nsecret_limit = "never-visible"\n[credentials]\nmax_size = "never-visible"\n[service]\nmax_size = 3\n',
    'src/shell/input.ts':'export const LIMIT = 7;\n',
    'keys.json':'{"max_size":"never-visible"}',
    'tokens.json':'{"max_size":"never-visible"}',
    'quoted.toml':'value = """\nmax_size = 999\n"""\n',
    '.env.json':'{"max_size":"never-visible"}',
    'credentials.json':'{"limit":"never-visible"}',
    'vendor/a.ts':'export const LIMIT = 999;',
    'dist/a.js':'export const LIMIT = 999;',
    '.gitignore':'ignored/\n',
    'ignored/a.ts':'export const LIMIT = 999;'
  });
  const s=await scanCodeEvidence(repo,'alpha'), text=JSON.stringify(s);
  const constants=s.items.filter(i=>i.kind==='constant');
  assert.equal(constants.find(i=>i.name==='TOP_K').value,8);
  assert.equal(constants.find(i=>i.name==='TOP_K').start,3);
  assert.ok(constants.some(i=>i.path==='config.yaml'&&i.value===16));
  assert.ok(constants.some(i=>i.path==='settings.toml'&&i.value===45));
  assert.ok(constants.some(i=>i.name==='nested.timeout'&&i.value===12));
  assert.ok(constants.some(i=>i.name==='service.max_size'&&i.value===3));
  assert.ok(s.items.some(i=>i.kind==='dependency'&&i.target==='src/shell/input.ts'));
  assert.ok(!s.items.some(i=>i.path==='quoted.toml'));
  assert.ok(!/never-visible|do-not-emit|FAKE_LIMIT|STRING_LIMIT|MAX_DYNAMIC/.test(text));
  assert.ok(!s.items.some(i=>/^(vendor|dist|ignored)\//.test(i.path)));
  assert.ok(s.items.every(i=>i.snippet.length<=400&&/^code:alpha:[a-f0-9]{12}:.+#L\d+-L\d+$/.test(i.ref)));
  assert.equal(moduleRefs(s)[0].layer,'core');
  assert.deepEqual(s,await scanCodeEvidence(repo,'alpha'));
});

test('Git snapshots honor tracked ignores, change on dirty content and pin clean commits',async t=>{
  const {repo,put}=await fixture(t,{'src/core/a.ts':'export const LIMIT = 1;\n','ignored.ts':'export const LIMIT = 999;\n'});
  git(repo,'init','-q'); git(repo,'add','.');
  git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture');
  const clean=await scanCodeEvidence(repo,'alpha');
  assert.equal(clean.revision,git(repo,'rev-parse','HEAD').slice(0,12));
  await put('.gitignore','ignored.ts\n');
  const first=await scanCodeEvidence(repo,'alpha');
  assert.ok(!first.items.some(i=>i.path==='ignored.ts'));
  await put('src/core/a.ts','export const LIMIT = 2;\n');
  const second=await scanCodeEvidence(repo,'alpha');
  assert.notEqual(first.revision,second.revision);
  assert.notEqual(second.revision,clean.revision);
  assert.deepEqual(second,await scanCodeEvidence(repo,'alpha'));
});

test('scanner skips symlinks, oversized/binary files and rejects escaping layer rules',async t=>{
  const {root,repo,put}=await fixture(t,{'src/core/a.ts':'export const LIMIT = 4;\n','large.ts':'a'.repeat(300000),'binary.ts':'a\0b'});
  const outside=join(root,'outside.ts');await writeFile(outside,'export const LIMIT = 991;\n');
  await symlink(outside,join(repo,'link.ts'));
  await symlink(root,join(repo,'escape'));
  const s=await scanCodeEvidence(repo,'alpha');
  assert.ok(!s.items.some(i=>/link|large|binary|escape/.test(i.path)));
  await put('.memhub/layers.json',JSON.stringify({layers:[{name:'core',paths:['../**']}],allowed:{core:[]}}));
  await assert.rejects(scanCodeEvidence(repo,'alpha'),/unsafe layer/);
  await put('.memhub/layers.json',JSON.stringify({layers:[{name:'core',paths:['src/**'],api_token:'hidden'}],allowed:{core:[]}}));
  await assert.rejects(scanCodeEvidence(repo,'alpha'),/invalid layer rule/);
});

test('constant and output budgets are explicit; source without layer rules has no layers',async t=>{
  const {repo}=await fixture(t,{'src/core/a.ts':Array.from({length:240},(_,i)=>'export const LIMIT_'+i+' = '+i+';').join('\n')});
  await rm(join(repo,'.memhub/layers.json'));
  const s=await scanCodeEvidence(repo,'alpha');
  assert.equal(s.layers.length,0);
  assert.ok(!moduleRefs(s).some(i=>i.layer));
  assert.ok(s.items.filter(i=>i.kind==='constant').length<=200);
  assert.ok(s.truncated.includes('constant_limit'));
  assert.ok(Buffer.byteLength(JSON.stringify(s))<=65536);
});

test('node layers use distinct files and the 80 percent threshold, never a manifest-only claim',async t=>{
  const files={};for(let i=0;i<4;i++)files['src/core/a'+i+'.ts']='export const LIMIT = 4;\n';
  for(let i=0;i<2;i++)files['src/shell/b'+i+'.ts']='export const LIMIT = 4;\n';
  const {repo}=await fixture(t,files),s=await scanCodeEvidence(repo,'alpha');
  const core=moduleRefs(s).filter(i=>i.layer==='core').map(i=>i.ref),shell=moduleRefs(s).filter(i=>i.layer==='shell').map(i=>i.ref);
  assert.equal(applyCodeLayers(candidate([...core,shell[0]]),s).nodes[1].facets.layer,'core');
  assert.equal(applyCodeLayers(candidate([...core.slice(0,3),...shell]),s).nodes[1].facets.layer,'mixed');
  assert.equal(applyCodeLayers(candidate([core[0],core[0],core[0],shell[0]]),s).nodes[1].facets.layer,'mixed');
  const only=candidate([s.layers[0].ref]);only.facet_vocab={layer:['core']};only.nodes[1].facets={layer:'core',layer_evidence_refs:[s.layers[0].ref]};
  assert.equal(applyCodeLayers(only,s).nodes[1].facets,undefined);
  assert.throws(()=>applyCodeLayers(candidate(['code:other:000000000000:a.ts#L1-L1']),s),/stale or foreign/);
});

test('bootstrap dry run is read-only; submit computes layers, retains exact review snippets and rejects stale code',async t=>{
  const {root,repo,put}=await fixture(t,{'src/core/a.ts':'// capture\nexport const TOP_K = 8;\n','settings.json':'{"max_size":32,"timeout":12}'});
  const architecture=new FileProjectArchitectureSource({rootDir:root,managedRootDir:join(root,'managed')});
  const deps={accountId:'acct',userId:'user',architecture,projects:{storageIds:async()=>['alpha']},
    memoryClient:{viewerGet:async()=>({items:[],total:0,hasNext:false})}};
  const stateRoot=join(root,'state');await mkdir(stateRoot);
  const pkg=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha'});
  const module=moduleRefs(pkg.code)[0],constant=pkg.code.items.find(i=>i.kind==='constant');
  assert.ok(pkg.allowed_refs.includes(constant.ref));
  const c=candidate([module.ref]);c.nodes[0].evidence_refs=[pkg.architecture_sources[0].sections[0].ref];
  c.nodes[1].facts=[{key:'top_k',value:8,evidence_refs:[constant.ref],confidence:.95}];
  const configRef=pkg.code.items.find(i=>i.name==='max_size').ref;
  c.nodes[1].facts.push({key:'timeout',value:12,evidence_refs:[configRef],confidence:.95});
  c.facet_vocab={layer:['shell']};c.nodes[1].facets={layer:'shell',layer_evidence_refs:[pkg.code.layers[1].ref]};
  const args={stateRoot,projectId:'alpha',base_fingerprint:pkg.base_fingerprint,architecture_map:c,source_harness:'test'};
  await mapBootstrapSubmit(deps,{...args,dry_run:true});
  const before=await architecture.inspectProjectCognitiveMap({accountId:'acct',projectId:'alpha'});
  assert.equal(before.exists,false);
  await assert.rejects(readdir(join(dirname(before.path),'code-evidence')),{code:'ENOENT'});
  const result=await mapBootstrapSubmit(deps,args);assert.equal(result.ok,true);
  const after=await architecture.inspectProjectCognitiveMap({accountId:'acct',projectId:'alpha'});
  assert.deepEqual(await readdir(join(dirname(after.path),'code-evidence')),[pkg.code.revision+'.json']);
  assert.equal(after.map.nodes[1].facets.layer,'mixed'); // One core file and one unassigned config file.
  const snippets=await architecture.getProjectCodeCitations({accountId:'acct',projectId:'alpha',refs:after.map.source_evidence_refs});
  assert.ok(snippets.some(i=>i.ref===constant.ref&&i.snippet.includes('8')));
  assert.deepEqual(await architecture.getProjectCodeCitations({accountId:'other',projectId:'alpha',refs:after.map.source_evidence_refs}),[]);
  const ctx={accountId:'acct',projectId:'alpha',map:after.map,jobs:[],gaps:[],events:[],artifacts:{get:()=>undefined},architectureSources:pkg.architecture_sources,codeEvidence:snippets};
  const cards=archReviewGenerator.ensure(ctx,Date.now());
  assert.ok(cards.some(card=>card.input.evidence.some(e=>e.ref===constant.ref&&e.excerpt.includes('8'))));
  assert.ok(cards.some(card=>card.input.evidence.some(e=>e.ref===configRef&&e.excerpt.includes('max_size = 32')&&e.excerpt.includes('timeout = 12'))));
  await put('src/core/a.ts','// capture\nexport const TOP_K = 9;\n');
  const changed=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha',rebuild:true});
  await assert.rejects(mapBootstrapSubmit(deps,{...args,rebuild:true,base_fingerprint:changed.base_fingerprint,dry_run:true}),/stale|outside allowed_refs/);
  const retained=await architecture.getProjectCodeCitations({accountId:'acct',projectId:'alpha',refs:[constant.ref]});
  assert.equal(retained[0].snippet,constant.snippet);
});

test('bootstrap retains verified historical code owners but rejects changed stale claims', async t => {
  const {root,repo,put}=await fixture(t,{'src/core/a.ts':'export const LIMIT = 8;\n'});
  git(repo,'init','-q');git(repo,'add','.');
  const commit=()=>git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture');
  commit();
  const architecture=new FileProjectArchitectureSource({rootDir:root,managedRootDir:join(root,'managed')});
  const deps={accountId:'acct',userId:'user',architecture,projects:{storageIds:async()=>['alpha']},
    memoryClient:{viewerGet:async()=>({items:[],total:0,hasNext:false})}};
  const stateRoot=join(root,'state');await mkdir(stateRoot);
  const first=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha'});
  const oldRef=moduleRefs(first.code)[0].ref;
  await mapBootstrapSubmit(deps,{stateRoot,projectId:'alpha',base_fingerprint:first.base_fingerprint,architecture_map:candidate([oldRef])});
  const read=()=>architecture.inspectProjectCognitiveMap({accountId:'acct',projectId:'alpha'});
  const before=await read();
  await put('README.md','An unrelated change creates a new code snapshot.\n');git(repo,'add','.');commit();
  const next=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha',rebuild:true});
  const base={stateRoot,projectId:'alpha',rebuild:true,base_fingerprint:next.base_fingerprint,dry_run:true};
  assert.notEqual(next.code.revision,first.code.revision);
  assert.equal((await mapBootstrapSubmit(deps,{...base,architecture_map:before.map})).ok,true);
  assert.equal((await read()).fingerprint,before.fingerprint);
  const translated=structuredClone(before.map);
  translated.nodes[1].label += ' / 采集输入';
  translated.nodes[1].summary = 'EN: ' + before.map.nodes[1].summary + ' ZH: 捕获有界输入。';
  assert.equal((await mapBootstrapSubmit(deps,{...base,architecture_map:translated})).ok,true, 'translation can retain the same historical code evidence');
  const changedEnglish=structuredClone(translated);changedEnglish.nodes[1].summary='EN: A different claim. ZH: 不同的主张。';
  await assert.rejects(mapBootstrapSubmit(deps,{...base,architecture_map:changedEnglish}),/stale code evidence/);
  const stale=structuredClone(before.map);stale.nodes[1].summary='A changed claim using old evidence';
  await assert.rejects(mapBootstrapSubmit(deps,{...base,architecture_map:stale}),/stale code evidence/);
  const added=structuredClone(before.map);added.nodes.push({...added.nodes[1],id:'new-node'});
  await assert.rejects(mapBootstrapSubmit(deps,{...base,architecture_map:added}),/stale code evidence/);
  const foreign=structuredClone(before.map);foreign.nodes[1].evidence_refs.push('code:other:000000000000:src/a.ts#L1-L1');
  await assert.rejects(mapBootstrapSubmit(deps,{...base,architecture_map:foreign}),/outside allowed_refs/);
  const changed=structuredClone(before.map);
  changed.nodes[1].summary='EN: Capture bounded input. ZH: 捕获有界输入。';
  changed.nodes[1].evidence_refs=[moduleRefs(next.code)[0].ref];
  delete changed.nodes[1].facets;
  assert.equal((await mapBootstrapSubmit(deps,{...base,architecture_map:changed})).ok,true);
  await mapBootstrapSubmit(deps,{...base,dry_run:false,architecture_map:changed});
  const after=await read();
  assert.equal(after.map.nodes[1].summary,changed.nodes[1].summary);
  assert.deepEqual(after.map.nodes[0],before.map.nodes[0]);
  await rm(join(dirname(after.path),'code-evidence',first.code.revision+'.json'));
  const last=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha',rebuild:true});
  await assert.rejects(mapBootstrapSubmit(deps,{...base,base_fingerprint:last.base_fingerprint,architecture_map:after.map}),/stale or foreign code evidence/);
  assert.equal((await read()).fingerprint,after.fingerprint);
});

test('repository layer manifest matches the existing five package boundaries',async()=>{
  const m=JSON.parse(await readFile(new URL('../.memhub/layers.json',import.meta.url),'utf8'));
  assert.deepEqual(m.layers.map(r=>r.name),['contracts','core','archify','shell','engine']);
  assert.deepEqual(m.allowed.core,['contracts']);assert.deepEqual(m.allowed.archify,['contracts','core']);
  assert.deepEqual(m.layers.find(r=>r.name==='shell').exclude,['src/contracts/**','src/core/**','src/archify/**']);
  const boundary=await readFile(new URL('./module-boundaries.mjs',import.meta.url),'utf8');
  assert.match(boundary,/contracts: \[\], core: \["contracts"\], archify: \["contracts", "core"\]/);
  assert.match(boundary,/vendor\/memory-core/);
});

test('gap support appends non-code corroboration without changing historical code claims or layers', async t => {
  const {root,repo,put}=await fixture(t,{'src/core/a.ts':'export const LIMIT = 8;\n'});
  git(repo,'init','-q');git(repo,'add','.');
  git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture');
  const architecture=new FileProjectArchitectureSource({rootDir:root,managedRootDir:join(root,'managed')});
  const deps={accountId:'acct',userId:'user',architecture,projects:{storageIds:async()=>['alpha']},
    memoryClient:{viewerGet:async()=>({items:[],total:0,hasNext:false})}};
  const stateRoot=join(root,'state');await mkdir(stateRoot);
  const pkg=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha'});
  const docRef=pkg.allowed_refs.find(ref=>ref.startsWith('architecture-doc:'));
  assert.ok(docRef);
  await mapBootstrapSubmit(deps,{stateRoot,projectId:'alpha',base_fingerprint:pkg.base_fingerprint,
    architecture_map:candidate([moduleRefs(pkg.code)[0].ref,docRef])});
  const read=()=>architecture.inspectProjectCognitiveMap({accountId:'acct',projectId:'alpha'});
  const before=await read();
  await put('README.md','An unrelated commit changes the snapshot identity.\n');
  git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','unrelated');
  const ref='l2:timeline:corroboration';
  const result=await maintenanceGenerators.get('gap_check').apply({kind:'gap_check',card_id:'gap',
    fingerprint:gapCheckFingerprint(before.map,'capture'),input:{node:{id:'capture'},gap:{id:'empty_branch:capture'}},allowed_refs:[ref]
  },{verdict:'supported',evidence_refs:[ref],confidence:.95,note:'The event supports capture.'},{
    map:{read,write:(map,expectedFingerprint)=>architecture.writeProjectCognitiveMap({accountId:'acct',projectId:'alpha',map,expectedFingerprint})}
  },{},Date.now());
  assert.equal(result.ok,true);
  const after=await read();
  assert.deepEqual(after.map.nodes[1],{...before.map.nodes[1],evidence_refs:[...before.map.nodes[1].evidence_refs,ref]});
  assert.deepEqual(after.map.nodes[0],before.map.nodes[0]);
  assert.equal(after.map.nodes[1].facets.layer,'core');
  const write=map=>architecture.writeProjectCognitiveMap({accountId:'acct',projectId:'alpha',map,expectedFingerprint:after.fingerprint});
  for(const mutate of [
    node=>{node.summary='A different code claim';},
    node=>{node.confidence=1;},
    node=>{node.evidence_refs=node.evidence_refs.filter(value=>value!==docRef);},
    node=>{node.facts=[{key:'limit',value:99,evidence_refs:[moduleRefs(pkg.code)[0].ref]}];}
  ]) {
    const changed=structuredClone(after.map);mutate(changed.nodes[1]);
    await assert.rejects(write(changed),/stale code evidence/);
  }
  assert.equal((await read()).fingerprint,after.fingerprint);
});

test('incremental maintenance retains snapshot-backed citations after unrelated commits but rejects new stale claims', async t => {
  const {root,repo,put}=await fixture(t,{'src/core/a.ts':'export const LIMIT = 8;\n'});
  git(repo,'init','-q'); git(repo,'add','.');
  git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','fixture');
  const architecture=new FileProjectArchitectureSource({rootDir:root,managedRootDir:join(root,'managed')});
  const deps={accountId:'acct',userId:'user',architecture,projects:{storageIds:async()=>['alpha']},
    memoryClient:{viewerGet:async()=>({items:[],total:0,hasNext:false})}};
  const stateRoot=join(root,'state');await mkdir(stateRoot);
  const pkg=await mapBootstrapNext(deps,{stateRoot,projectId:'alpha'});
  await mapBootstrapSubmit(deps,{stateRoot,projectId:'alpha',base_fingerprint:pkg.base_fingerprint,
    architecture_map:candidate([moduleRefs(pkg.code)[0].ref])});
  const read=()=>architecture.inspectProjectCognitiveMap({accountId:'acct',projectId:'alpha'});
  const before=await read();
  await put('README.md','Unrelated documentation change.\n');
  git(repo,'add','.');git(repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','unrelated');
  assert.notEqual((await architecture.getProjectCodeEvidence({accountId:'acct',projectId:'alpha'})).revision,pkg.code.revision);
  const result=await maintenanceGenerators.get('arch_link').apply({
    kind:'arch_link',fingerprint:structureFingerprint(before.map),allowed_refs:['l2:timeline:revision'],
    input:{event:{date:'2026-10-28',title:'Capture update'}}
  },{links:[{architecture_refs:['capture'],architecture_level:'capability',change_kind:'refine',confidence:.9}]},{
    map:{read,write:(map,expectedFingerprint)=>architecture.writeProjectCognitiveMap({accountId:'acct',projectId:'alpha',map,expectedFingerprint})}
  });
  assert.equal(result.ok,true);
  const after=await read();
  assert.deepEqual(after.map.nodes,before.map.nodes);
  assert.equal(after.map.timeline_links.length,1);
  assert.equal(after.map.nodes[1].facets.layer,'core');
  const write=map=>architecture.writeProjectCognitiveMap({accountId:'acct',projectId:'alpha',map,expectedFingerprint:after.fingerprint});
  const changed=structuredClone(after.map);changed.nodes[1].summary='A new claim using old evidence';
  await assert.rejects(write(changed),/stale code evidence/);
  const added=structuredClone(after.map);added.nodes.push({...added.nodes[1],id:'new-node'});
  await assert.rejects(write(added),/stale code evidence/);
  const foreign=structuredClone(after.map);foreign.source_evidence_refs.push('code:other:000000000000:src/a.ts#L1-L1');
  await assert.rejects(write(foreign),/stale or foreign/);
  await rm(join(dirname(after.path),'code-evidence',pkg.code.revision+'.json'));
  await assert.rejects(write(after.map),/stale or foreign/);
  assert.equal((await read()).fingerprint,after.fingerprint);
});
