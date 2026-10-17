import { randomUUID } from 'node:crypto';
export const ROLES = Object.freeze({architect:{capabilities:['design','review']},backend:{capabilities:['implement','test']}});
export function planMission(objective,project) {
 if(typeof objective!=='string'||!objective.trim()||!project) throw Error('Objective and project required');
 const id=randomUUID();
 return {id,project,objective:objective.trim(),status:'pending_approval',created_at:new Date().toISOString(),
 tasks:[{id:randomUUID(),role:'architect',instruction:'Analyze requirements and propose implementation plan for: '+objective,status:'queued'},
 {id:randomUUID(),role:'backend',instruction:'Implement and test approved architecture for: '+objective,status:'blocked',depends_on:'architect'}]};
}
export function validateTransition(from,to){const allowed={pending_approval:['approved','cancelled'],approved:['running','cancelled'],running:['blocked','review','failed'],blocked:['running','cancelled'],review:['completed','running'],failed:[],completed:[],cancelled:[]};if(!allowed[from]?.includes(to))throw Error('Invalid transition '+from+' -> '+to);return to;}
export function summarize(mission,reports){return {mission_id:mission.id,status:mission.status,reports:reports.map(r=>({role:r.role,status:r.status,summary:r.summary,evidence:r.evidence||[]})),blockers:reports.filter(r=>r.status==='blocked').map(r=>r.summary)};}
