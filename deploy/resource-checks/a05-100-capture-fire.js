async page => {
  let data;
  for (let attempt=0; attempt<30; attempt++) {
    data = await page.evaluate(async () => {
      const state = await (await fetch('/api/state')).json();
      const response = await fetch('/api/explanations/current');
      const explanation = await response.json();
      return {state, explanation, server_time: response.headers.get('X-Explanation-Server-Time'),
        displayed_summary: document.querySelector('.explanation__text')?.textContent,
        displayed_meta: document.querySelector('.explanation__meta')?.textContent};
    });
    if (data.state.controller_mode==='EMERGENCY' && data.explanation.status==='READY'
        && data.explanation.run_id===data.state.run_id
        && data.explanation.guidance_version===data.state.guidance_version
        && data.displayed_summary===data.explanation.summary) break;
    await page.waitForTimeout(700);
  }
  if (data.state.controller_mode!=='EMERGENCY' || data.explanation.status!=='READY'
      || data.explanation.run_id!==data.state.run_id
      || data.explanation.guidance_version!==data.state.guidance_version
      || data.displayed_summary!==data.explanation.summary
      || data.state.routes.find(x=>x.node_id==='S').next_node_id!=='B'
      || !data.state.active_causes.some(x=>x.source_id==='CAM-A' && x.hazard_type==='FIRE')) {
    throw new Error('actual AI fire/route/Bedrock/UI mismatch');
  }
  await page.screenshot({path:'output/playwright/a05-100/fire-ready.png',fullPage:true});
  return {case:'actual_video_fire_ready',status:'PASS',...data};
}
