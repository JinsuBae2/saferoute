async page => {
  const before = await page.evaluate(async()=>await(await fetch('/api/state')).json());
  await page.waitForTimeout(4500);
  const data = await page.evaluate(async()=>{
    const state=await(await fetch('/api/state')).json();
    const reply=await fetch('/api/explanations/current');
    return {state, explanation_http_status:reply.status,
      summary_visible:document.querySelector('.explanation__text')!==null, body:document.querySelector('main').innerText};
  });
  if(data.explanation_http_status<500 || data.summary_visible || data.state.controller_mode!=='EMERGENCY'
     || data.state.routes.find(x=>x.node_id==='S').next_node_id!=='B') throw new Error('explanation stop affected control or stale text remained');
  for(const sign of data.state.signs) {
    const prior=before.signs.find(x=>x.sign_id===sign.sign_id);
    const current=sign.terminals.find(x=>x.verified && x.last_ack.status==='APPLIED');
    const old=prior.terminals.find(x=>x.verified && x.last_ack.status==='APPLIED');
    if(!current || !old || current.last_ack.command_sequence<=old.last_ack.command_sequence
       || current.last_ack.guidance_version!==data.state.guidance_version) throw new Error('terminal ACK stopped');
  }
  await page.screenshot({path:'output/playwright/a05-100/explanation-offline.png',fullPage:true});
  return {case:'actual_worker_stopped_control_and_two_terminals_continue',status:'PASS',before,...data};
}
