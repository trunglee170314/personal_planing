import { describe,it,expect } from 'vitest';
import { LocalDatabase } from '../local-server/database.mjs';
import { goalColors,goalColorValue } from '../lib/colors';
import { descendantIds } from '../lib/task-hierarchy';
import { milestoneLevels } from '../lib/workspace-view';

describe('workspace extras',()=>{
  it('offers twelve distinct persisted Goal colors',()=>{
    expect(goalColors).toHaveLength(12);
    expect(new Set(goalColors.map((color)=>color.value)).size).toBe(12);
    const db=new LocalDatabase(':memory:');
    try{for(const color of goalColors.slice(-4)){const id=db.createGoal({title:color.name,color_key:color.id});expect(db.listGoals().find((goal)=>goal.id===id)?.color_key).toBe(color.id);expect(goalColorValue(color.id)).toBe(color.value);}}finally{db.close();}
  });
  it('keeps milestone comments after permanently removing its Goal',()=>{
    const db=new LocalDatabase(':memory:');try{
      const goalId=db.createGoal({title:'Parent'});
      const milestoneId=db.createTimelineMilestone({title:'Deadline',goal_id:goalId,milestone_on:'2026-09-12'});
      db.saveAnnotation({kind:'milestone',id:milestoneId},{kind:'comment',body:'Keep my note',url:null});
      db.updateGoal(goalId,{deleted_at:new Date().toISOString()});db.deleteGoal(goalId);
      expect(db.getTimelineWorkspace().milestones.find((item)=>item.id===milestoneId)?.goal_id).toBeNull();
      expect(db.listAnnotations({kind:'milestone',id:milestoneId})[0].body).toBe('Keep my note');
    }finally{db.close();}
  });
  it('stores holidays and rejects reversed ranges',()=>{
    const db=new LocalDatabase(':memory:');try{
      db.saveHoliday({title:'Holiday',starts_on:'2026-09-03',ends_on:'2026-09-05'});
      expect(db.listHolidays()[0].title).toBe('Holiday');
      expect(()=>db.saveHoliday({title:'Invalid',starts_on:'2026-09-05',ends_on:'2026-09-03'})).toThrow();
    }finally{db.close();}
  });
  it('places overlapping flags on separate levels and reuses clear levels',()=>{
    expect([...milestoneLevels([{id:'a',milestone_on:'2026-09-01'},{id:'b',milestone_on:'2026-09-01'},{id:'c',milestone_on:'2026-09-05'}],18).values()]).toEqual([0,1,0]);
  });
  it('finds descendants even when old data contains a cycle',()=>{
    expect([...descendantIds([{id:'a',parent_task_id:'b'},{id:'b',parent_task_id:'a'}],'a')]).toEqual(['a','b']);
  });
});
