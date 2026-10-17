import {runClaude} from './runner.js';
import {ROLES} from './core.js';
export async function executeTask(task,{workspace,approved=false,runner=runClaude}={}){
 if(!ROLES[task.role])throw Error('Unknown specialist role');
 if(task.status!=='queued')throw Error('Task is not queued');
 if(!approved)throw Error('Explicit owner approval required');
 const started=new Date().toISOString();
 try {
 const result=await runner({instruction:'You are the '+task.role+' specialist. Work only inside your assigned workspace. Report verifiable file changes, tests and blockers. Task: '+task.instruction,cwd:workspace,approved:true});
 return {task_id:task.id,role:task.role,status:'review',summary:typeof result.result==='string'?result.result:'Claude task completed; inspect evidence',evidence:[],started_at:started,finished_at:new Date().toISOString(),raw_result:result};
 }catch(error){return {task_id:task.id,role:task.role,status:'blocked',summary:String(error.message),evidence:[],started_at:started,finished_at:new Date().toISOString()};}
}
