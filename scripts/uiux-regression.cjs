// Run against an isolated localhost app; never accepts a public production URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const env = JSON.parse(fs.readFileSync(process.env.UIUX_STAGE_ENV, 'utf8'));
const base = process.env.UIUX_BASE_URL || env.NEXTAUTH_URL;
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const { chromium } = require(process.env.UIUX_PLAYWRIGHT_PATH || 'playwright-core');
const out = process.env.UIUX_ARTIFACTS || '/tmp/autoreels-uiux-stage';
fs.mkdirSync(out, { recursive: true });
const results = [];
function pass(name, details) { results.push({ name, ...details }); console.log(JSON.stringify({ passed: name, ...details })); }
(async () => {
 const browser = await chromium.launch({ executablePath: process.env.UIUX_CHROMIUM || '/snap/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
 try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, timezoneId: 'America/Sao_Paulo' });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/login', { waitUntil: 'networkidle', timeout: 120000 });
  await page.locator('input[type=email]').fill(env.ADMIN_EMAIL); await page.locator('input[type=password]').fill(env.ADMIN_PASSWORD);
  await page.locator('button[type=submit]').click(); await page.waitForURL(base + '/', { timeout: 120000 });
  const api = context.request;
  let all = await api.get(base + '/api/post-stats?all=1'); assert.equal(all.status(), 200); all = await all.json();
  const start = new Date(await page.evaluate(() => { const d = new Date(); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0); return d.toISOString(); }));
  const statsResponse = await api.get(base + '/api/post-stats?' + new URLSearchParams({ days: '30', start: start.toISOString(), tz: 'America/Sao_Paulo' }));
  assert.equal(statsResponse.status(), 200); const stats = await statsResponse.json();
  const oracle = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3,datetime,json,sys,zoneinfo,collections
p,start,end=sys.argv[1:];db=sqlite3.connect('file:'+p+'?mode=ro',uri=True)
a=datetime.datetime.fromisoformat(start.replace('Z','+00:00'));b=datetime.datetime.fromisoformat(end.replace('Z','+00:00'))
def date(v):
 if v is None:return None
 if isinstance(v,(int,float)):return datetime.datetime.fromtimestamp(v/1000,datetime.timezone.utc)
 return datetime.datetime.fromisoformat(str(v).replace('Z','+00:00')).replace(tzinfo=datetime.timezone.utc)
statuses=collections.Counter();daily=collections.Counter();heat=[[0]*24 for _ in range(7)];total=0;calendar=[]
for ident,status,created,scheduled,published in db.execute("SELECT id,status,created_at,scheduled_at,published_at FROM posts WHERE user_id='admin'"):
 total+=1;dates=[date(published),date(scheduled),date(created)]
 effective=next(d for d in dates if d)
 if a<=effective<=b:
  statuses[status]+=1
  if status=='published' and a<=effective<=b:
   local=effective.astimezone(zoneinfo.ZoneInfo('America/Sao_Paulo'));daily[local.strftime('%Y-%m-%d')]+=1;heat[(local.weekday()+1)%7][local.hour]+=1
 s=date(scheduled)
 if s and datetime.datetime(2026,8,25,tzinfo=datetime.timezone.utc)<=s<=datetime.datetime(2026,10,14,tzinfo=datetime.timezone.utc):calendar.append(ident)
print(json.dumps(dict(total=total,statuses=statuses,dailyPublished=daily,heatmap=heat,calendar=calendar)))
`, env.DATABASE_URL.replace(/^file:/, ''), stats.start, stats.end], { encoding: 'utf8' }));
  assert.equal(all.total, oracle.total); assert.deepEqual(stats.statuses, oracle.statuses); assert.deepEqual(stats.dailyPublished, oracle.dailyPublished); assert.deepEqual(stats.heatmap, oracle.heatmap);
  pass('complete aggregates and Brasília timezone', { total: all.total, windowTotal: stats.total });
  let offset=0, ids=[];
  do { const r = await api.get(base + '/api/calendar?' + new URLSearchParams({ start:'2026-08-25T00:00:00Z', end:'2026-10-14T00:00:00Z',limit:'1000',offset:String(offset) })); assert.equal(r.status(),200); const data=await r.json();ids.push(...data.posts.map(p=>p.id));assert(data.nextOffset>=offset);offset=data.nextOffset;if(!data.hasMore)break; } while(offset<100000);
  assert.equal(ids.length,new Set(ids).size);assert.deepEqual(ids.sort(),oracle.calendar.sort());assert(ids.length>1000);pass('calendar pagination without omissions', { posts:ids.length });
  for (const path of ['/','/content','/new','/channels','/analytics','/settings','/upload','/automations','/planners']) {
   await page.goto(base+path,{waitUntil:'networkidle',timeout:120000});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'horizontal overflow '+path);
   await page.screenshot({path:out+'/'+(path.slice(1).replaceAll('/','-')||'calendar')+'-mobile-final.png',fullPage:true});
  }
  assert.deepEqual(errors,[]);pass('nine mobile routes without overflow or JS errors');
  await page.goto(base+'/planners?new=1',{waitUntil:'networkidle'});
  const wizard=page.getByRole('dialog');await wizard.waitFor();
  assert(!new URL(page.url()).searchParams.has('new'));
  const close=wizard.getByRole('button',{name:'Fechar',exact:true});const bounds=await wizard.boundingBox(), x=await close.boundingBox();assert(x.x>=bounds.x && x.x+x.width<=bounds.x+bounds.width+1);assert(x.width>=44 && x.height>=44);
  await page.getByLabel('Nome do planner').fill('Validação de interface');await page.keyboard.press('Tab');assert(await wizard.evaluate(el=>el.contains(document.activeElement)));
  await page.screenshot({path:out+'/wizard-mobile-final.png'});await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);pass('planner deep link, close button and focus');
  await page.goto(base+'/channels',{waitUntil:'networkidle'});await page.getByRole('button',{name:/Adicionar canal|Novo canal/i}).first().click();
  const channel=page.getByRole('dialog');await channel.waitFor();assert(await channel.evaluate(el=>getComputedStyle(el).backgroundColor!=='rgba(0, 0, 0, 0)'));
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
  for(let i=0;i<15;i++){await page.keyboard.press('Tab');assert(await channel.evaluate(el=>el.contains(document.activeElement)));}
  assert(await page.evaluate(()=>!document.elementFromPoint(innerWidth/2,innerHeight-12)?.closest('nav')));await page.keyboard.press('Escape');assert.notEqual(await page.evaluate(()=>document.body.style.overflow),'hidden');pass('opaque dialogs, focus trap and navigation overlay');
  await page.goto(base+'/new',{waitUntil:'networkidle'});await page.getByLabel('Canal',{exact:true}).selectOption('uiux-youtube');
  const when = await page.evaluate(()=>{const d=new Date(Date.now()+600000);const p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;});
  const schedule=page.getByLabel('Agendar',{exact:true});await schedule.fill(when);assert.equal(await schedule.evaluate(el=>el.validity.rangeUnderflow),false);
  await page.getByRole('button',{name:'Escolher da Biblioteca',exact:true}).click();const picker=page.getByRole('dialog');await picker.waitFor();
  const select=picker.getByRole('button',{name:/^Selecionar vídeo /}).first();await select.waitFor({timeout:30000});assert((await select.boundingBox()).height>20);await select.click();
  // Selection mode must not invoke deletion shortcuts.
  let deletes=0;page.on('request',r=>{if(r.method()==='DELETE')deletes++;});await page.keyboard.press('Delete');assert.equal(deletes,0);
  await picker.getByRole('button',{name:'Usar seleção',exact:true}).click();await picker.waitFor({state:'hidden'});
  assert.equal(await page.locator('#file-upload').evaluate(el=>el.validity.valueMissing),false);
  await page.getByLabel(/Título/).fill('Teste de seleção existente');
  let createBody;const submitted=page.waitForResponse(r=>r.url()===base+'/api/posts'&&r.request().method()==='POST');page.on('request',r=>{if(r.url()===base+'/api/posts'&&r.method()==='POST')createBody=r.postDataJSON();});
  await page.getByRole('button',{name:'Agendar Short',exact:true}).click();const confirm=page.getByRole('dialog');await confirm.waitFor();await confirm.getByRole('button',{name:'Confirmar agendamento'}).click();const created=await submitted;assert(created.ok());const post=await created.json();assert.equal(createBody.video_url,base+'/api/file/admin/fixture.mp4');assert.equal(createBody.youtube_type,'short');assert.equal(new Date(createBody.scheduled_at).getTime(),new Date(when+'-03:00').getTime());
  if(post.id)await api.delete(base+'/api/posts/'+post.id);pass('library reuse, local schedule and public confirmation');
  await context.close();const guest=await browser.newContext();for(const path of ['/termos','/privacidade']){const p=await guest.newPage();await p.goto(base+path,{waitUntil:'networkidle'});assert(new URL(p.url()).pathname===path);await p.close();}await guest.close();pass('public terms and privacy');
  fs.writeFileSync(out+'/regression-results.json',JSON.stringify(results,null,2));
 } finally {await browser.close();}
})().catch(e=>{console.error(e.message.split('Call log:')[0]);process.exitCode=1;});
