import { expect, it } from 'vitest';
import { projectGraph } from './graph.js';

it('retains untimed and cancelled attempts, zero tokens, and fresher current-attempt data', () => {
 const snapshot={graphRunId:'g',revision:0,status:'cancelled',edges:[],nodes:[{id:'n',logicalState:'cancelled',attemptHistory:[{id:'first',number:1,state:'failed',tokens:4},{id:'second',number:2,state:'running',tokens:0}],currentAttempt:{id:'second',number:2,state:'cancelled',tokens:2}}]};
 const rows=projectGraph(snapshot).graphTimeline;
 expect(rows).toHaveLength(2);expect(rows.map(r=>r.tokens)).toEqual([4,2]);
 expect(rows[1]).toMatchObject({state:'cancelled',attemptState:'cancelled',attemptId:'second'});
 expect(rows.every(r=>r.startedAt===undefined&&r.endedAt===undefined)).toBe(true);
 expect(projectGraph({...snapshot,nodes:[{...snapshot.nodes[0],attemptHistory:[],currentAttempt:{id:'queued',number:1,state:'queued',tokens:0}}]}).graphTimeline[0].tokens).toBe(0);
});

it('rejects unrecognized persisted graph shapes instead of silently emitting unknown/empty nodes', () => {
 expect(()=>projectGraph({nodes:[{id:'n',status:'completed'}]})).toThrow();
 expect(()=>projectGraph({graphRunId:'g',revision:0,status:'completed',nodes:[{id:'n',logicalState:'succeeded',attemptHistory:[{id:'a',number:1,state:'succeeded',startedAt:'bad timestamp'}]}],edges:[]})).toThrow();
});
