async page => {
  await page.waitForSelector('.explanation__text', {timeout: 30000});
  const data = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const response = await fetch('/api/explanations/current');
    const explanation = await response.json();
    return {state, explanation, server_time: response.headers.get('X-Explanation-Server-Time'),
      cache_control: response.headers.get('Cache-Control'),
      displayed_summary: document.querySelector('.explanation__text')?.textContent,
      displayed_meta: document.querySelector('.explanation__meta')?.textContent};
  });
  if (data.state.controller_mode !== 'NORMAL' || data.explanation.status !== 'READY'
      || data.explanation.run_id !== data.state.run_id
      || data.explanation.guidance_version !== data.state.guidance_version
      || data.displayed_summary !== data.explanation.summary
      || !data.displayed_meta.includes('AI 작성') || data.cache_control !== 'no-store') {
    throw new Error('actual normal explanation/UI identity mismatch');
  }
  await page.screenshot({path: 'output/playwright/a05-100/normal.png', fullPage: true});
  return {case: 'actual_normal_ready', status: 'PASS', ...data};
}
