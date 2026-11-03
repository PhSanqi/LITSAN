import argparse
import importlib.util
import json
import tempfile
import unittest
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).with_name('evaluate_memory_quality.py')
spec = importlib.util.spec_from_file_location('memory_quality_eval', MODULE_PATH)
mq = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mq
assert spec.loader is not None
spec.loader.exec_module(mq)


class MemoryQualityEvaluatorTests(unittest.TestCase):
    def test_normalize_compound_evidence_ids(self):
        self.assertEqual(mq.normalize_evidence_id('D8:6; D9:17'), ['D8:6', 'D9:17'])
        self.assertEqual(mq.normalize_evidence_id('D:11:26'), ['D11:26'])
        self.assertEqual(mq.normalize_evidence_id('D30:05'), ['D30:5'])
        self.assertEqual(mq.normalize_evidence_id('D9:1 D4:4 D4:6'), ['D9:1', 'D4:4', 'D4:6'])

    def test_evidence_session_ids(self):
        self.assertEqual(mq.evidence_session_ids(['D1:3', 'D1:9', 'D7:2']), [1, 7])
        self.assertEqual(mq.evidence_session_ids('D8:6; D9:17'), [8, 9])
        self.assertEqual(mq.evidence_session_ids('D'), [])

    def test_locomo_gold_contract(self):
        dataset_path = Path(__file__).parents[2] / '.review-runtime/memory-arena/OmniMemEval/data/locomo/locomo10.json'
        dataset = json.loads(dataset_path.read_text())
        grouped, meta = mq.build_gold(dataset)
        self.assertEqual(len(grouped), 10)
        self.assertEqual(meta['questions'], 1540)
        self.assertEqual(len(meta['unresolved_gold_refs']), 2)
        self.assertEqual(meta['no_resolvable_gold_questions'], 4)
        categories = {q.category for rows in grouped.values() for q in rows}
        self.assertEqual(categories, {1, 2, 3, 4})

    def test_dual_lane_k_is_per_lane_union(self):
        dataset = [{
            'conversation': {
                'speaker_a': 'A', 'speaker_b': 'B',
                'session_1': [
                    {'dia_id': 'D1:1', 'speaker': 'A', 'text': 'alpha gold fact'},
                    {'dia_id': 'D1:2', 'speaker': 'B', 'text': 'beta gold fact'},
                ],
            },
            'qa': [{
                'question': 'q?', 'answer': 'a', 'category': 1,
                'evidence': ['D1:1', 'D1:2'],
            }],
        }]
        trace = {'groups': {'locomo_exp_user_0': [{
            'query': 'q?', 'status': 'success', 'duration_ms': 1,
            'lanes': {
                'speaker_a': [
                    {'id': 'a0', 'content': 'noise'},
                    {'id': 'a1', 'content': 'alpha gold fact'},
                ],
                'speaker_b': [
                    {'id': 'b0', 'content': 'beta gold fact', 'session_id': 'locomo_exp_user_0_session_1'},
                ],
            },
        }]}}
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            dataset_path = td / 'dataset.json'
            trace_path = td / 'trace.json'
            out_path = td / 'out.json'
            dataset_path.write_text(json.dumps(dataset))
            trace_path.write_text(json.dumps(trace))
            args = argparse.Namespace(
                dataset=str(dataset_path), search_results=str(trace_path), backend='synthetic',
                output=str(out_path), embedding_base_url='', embedding_model='BAAI/bge-small-en-v1.5',
                embedding_batch_size=64, ks=(1, 2), include_queries=True,
            )
            result = mq.evaluate(args)
        strict = result['aggregate']['strict_content_trace']
        self.assertEqual(strict['rank_semantics'], 'per_lane_union')
        self.assertEqual(strict['recall_at_k']['1'], 0.5)
        self.assertEqual(strict['hit_at_k']['1'], 1.0)
        self.assertEqual(strict['recall_at_k']['2'], 1.0)
        session = result['aggregate']['session_provenance']
        self.assertEqual(session['scope'], 'session')
        self.assertEqual(session['rank_semantics'], 'per_lane_union')
        self.assertEqual(session['recall_at_k']['1'], 1.0)
        self.assertEqual(session['hit_at_k']['1'], 1.0)
        self.assertEqual(session['mrr'], 1.0)


if __name__ == '__main__':
    unittest.main()
