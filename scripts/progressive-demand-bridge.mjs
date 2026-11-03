import {parseProgressiveDemand,PROGRESSIVE_DEMAND_SCHEMA} from '../dist/core/context/progressive-demand.js';
if(process.argv[2]==='schema')console.log(JSON.stringify(PROGRESSIVE_DEMAND_SCHEMA));
else {
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const requests=JSON.parse(input);
 console.log(JSON.stringify(requests.map(({value,limits})=>{
  try{return {demand:parseProgressiveDemand(value,limits)}}catch(error){return {error:String(error.message)}}
 })));
}
