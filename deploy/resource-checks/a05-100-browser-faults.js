// Playwright CLI run-code function. Seed window.__a05ProbeReady with this run's captured real READY DTO.
// These are explicitly synthetic response faults, not new Bedrock responses or provider outages.
async page => {
  const template = await page.evaluate(() => window.__a05ProbeReady);
  if (!template || template.status !== 'READY') throw new Error('capture a real READY response first');
  const cases = [];
  for (const name of ['pending', 'old_guidance', 'wrong_building', 'expired']) {
    let lastInjected;
    await page.unroute('**/api/explanations/current');
    await page.route('**/api/explanations/current', async route => {
      const origin = new URL(page.url()).origin;
      const state = await (await page.request.get(origin+'/api/state')).json();
      const now = state.generated_at;
      const time = Date.parse(now);
      const value = {...template, run_id:state.run_id, building_id:state.building_id,
        building_version:state.building_version, guidance_version:state.guidance_version,
        basis_generated_at:now, generated_at:now, expires_at:new Date(time+15000).toISOString()};
      if (name==='pending') Object.assign(value, {status:'PENDING', generated_at:null, expires_at:null,
        summary:null, fact_refs:[], error_code:null});
      if (name==='old_guidance') {
        if (state.guidance_version<1) throw new Error('need nonzero current guidance version');
        value.guidance_version=state.guidance_version-1;
      }
      if (name==='wrong_building') value.building_version=state.building_version+1;
      if (name==='expired') Object.assign(value, {basis_generated_at:new Date(time-20000).toISOString(),
        generated_at:new Date(time-19000).toISOString(), expires_at:new Date(time-5000).toISOString()});
      lastInjected={value,server_time:now};
      await route.fulfill({status:200, contentType:'application/json',
        headers:{'Cache-Control':'no-store','X-Explanation-Server-Time':now},body:JSON.stringify(value)});
    });
    await page.waitForTimeout(6500);
    const view = await page.evaluate(async()=>({
      state:await(await fetch('/api/state')).json(),
      summary_visible:document.querySelector('.explanation__text')!==null,
      text:document.querySelector('main').innerText
    }));
    if (!lastInjected || view.summary_visible) throw new Error(name+' stale text visible or injection unused');
    if (name==='pending' && !view.text.includes('설명을 준비 중이거나 제공할 수 없습니다')) throw new Error('PENDING not distinguished');
    if (name==='old_guidance' && !view.text.includes('안내가 바뀌어 이전 설명을 숨겼습니다')) throw new Error('old guidance not rejected');
    if (name==='wrong_building' && !view.text.includes('다른 건물 자료의 설명이라 숨겼습니다')) throw new Error('building mismatch not rejected');
    if(view.state.controller_mode!=='EMERGENCY' || view.state.routes.find(x=>x.node_id==='S').next_node_id!=='B') {
      throw new Error('fault injection changed control');
    }
    await page.screenshot({path:'output/playwright/a05-100/'+name+'.png',fullPage:true});
    cases.push({case:name,status:'PASS',evidence_kind:'SYNTHETIC_RESPONSE_INJECTION',injected:lastInjected,...view});
  }
  await page.unroute('**/api/explanations/current');
  return cases;
}
