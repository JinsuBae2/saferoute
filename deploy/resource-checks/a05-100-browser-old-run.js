// Run after the task-only controller reset; only the old run ID is preserved in this synthetic response.
async page => {
  const template=await page.evaluate(()=>window.__a05ProbeReady);
  if(!template || template.status!=='READY') throw new Error('captured READY is required');
  let lastInjected;
  await page.unroute('**/api/explanations/current');
  await page.route('**/api/explanations/current',async route=>{
    const state=await(await page.request.get(new URL(page.url()).origin+'/api/state')).json();
    if(state.run_id===template.run_id) throw new Error('controller must reset first');
    const now=state.generated_at;
    const value={...template, guidance_version:state.guidance_version, basis_generated_at:now, generated_at:now,
      expires_at:new Date(Date.parse(now)+15000).toISOString()};
    lastInjected={value,server_time:now};
    await route.fulfill({status:200,contentType:'application/json',
      headers:{'Cache-Control':'no-store','X-Explanation-Server-Time':now},body:JSON.stringify(value)});
  });
  await page.waitForTimeout(6500);
  const view=await page.evaluate(async()=>({state:await(await fetch('/api/state')).json(),
    summary_visible:document.querySelector('.explanation__text')!==null,text:document.querySelector('main').innerText}));
  if(!lastInjected || view.summary_visible || !view.text.includes('다른 실행의 설명이라 숨겼습니다')) {
    throw new Error('old run explanation was not explicitly rejected');
  }
  await page.screenshot({path:'output/playwright/a05-100/old-run.png',fullPage:true});
  await page.unroute('**/api/explanations/current');
  return {case:'old_run_after_actual_reset',status:'PASS',evidence_kind:'SYNTHETIC_RESPONSE_INJECTION',injected:lastInjected,...view};
}
