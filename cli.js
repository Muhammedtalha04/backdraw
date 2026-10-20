'use strict';
// Command line access to the bridge, for setup and troubleshooting.
const path = require('path');
const bridge = require('./shared');

const USAGE = `Kullanım: node cli.js <komut>
  status                          Köprü durumu (Chrome bağlı mı, seçili proje, kuyruk)
  projects                        ChatGPT projelerini listele
  select <ad | link>              Görsellerin üretileceği projeyi seç
  generate "<istem>" [--ref GÖRSEL]... [--url SOHBET_LİNKİ] [--reattach] [--out KLASÖR] [--raw] [--wait 300]
                                  Görsel üret; --ref ile referans/düzenlenecek görsel ekle (en fazla 4)
  collect <sohbet linki> [--out KLASÖR]   Mevcut bir sohbetteki son görselleri indir (mesaj göndermez)
  job <id> [--wait 60]            İş durumunu göster
  cancel <id>                     İşi iptal et
  outdir <klasör>                 Merkezi görsel klasörünü değiştir
  debug on|off                    Ayrıntılı kayıt (logs/host.log)
  diagnose [link] [--selector CSS] [--max N] [--worker]   Sayfa tanılama
  reload                          Chrome eklentisini yeniden yükle`;

const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reference', 'text_reply']);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Repeated flags (--ref a --ref b) become arrays.
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    const value = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[key] = key in flags ? [].concat(flags[key], value) : value;
  }
  return { pos, flags };
}

const print = v => console.log(JSON.stringify(v, null, 2));

async function follow(jobId, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  let job = await bridge.call('job', { jobId });
  let last = '';
  for (;;) {
    const note = `${job.status} | ${job.step} | ${job.message || ''}`;
    if (note !== last) { console.error(`[${new Date().toLocaleTimeString()}] ${note}`); last = note; }
    if (FINAL.has(job.status) || Date.now() > deadline) return bridge.copyResults(job);
    await sleep(1500);
    job = await bridge.call('job', { jobId });
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  const copyTo = typeof flags.out === 'string' ? path.resolve(flags.out) : undefined;
  switch (cmd) {
    case 'status': return print(await bridge.call('status'));
    case 'projects': return print(await bridge.call('list_projects', {}, 130000));
    case 'select': {
      const v = pos.join(' ');
      if (!v) throw new Error('Proje adı veya linki gerekli.');
      return print(await bridge.call('select_project', /^https?:\/\//i.test(v) ? { url: v } : { name: v }, 130000));
    }
    case 'generate': {
      const prompt = pos.join(' ');
      if (!prompt) throw new Error('İstem gerekli.');
      const job = await bridge.call('generate', {
        prompt, copyTo, references: bridge.readReferences(flags.ref ? [].concat(flags.ref) : []),
        startUrl: typeof flags.url === 'string' ? flags.url : undefined, sendAsIs: !!flags.raw, autoReattach: !!flags.reattach,
      }, 60000);
      console.error(`İş: ${job.id}`);
      return print(await follow(job.id, Number(flags.wait) || 600));
    }
    case 'collect': {
      if (!pos[0]) throw new Error('Sohbet linki gerekli.');
      const job = await bridge.call('generate', { mode: 'collect', startUrl: pos[0], copyTo });
      console.error(`İş: ${job.id}`);
      return print(await follow(job.id, Number(flags.wait) || 300));
    }
    case 'job': return print(await follow(pos[0], Number(flags.wait) || 0));
    case 'cancel': return print(await bridge.call('cancel', { jobId: pos[0] }));
    case 'outdir': return print(await bridge.call('set_config', { outputDir: path.resolve(pos[0]) }));
    case 'debug': return print(await bridge.call('set_config', { debug: pos[0] === 'on' }));
    case 'diagnose':
      return print(await bridge.call('diagnose', {
        url: pos[0], selector: flags.selector, max: flags.max ? Number(flags.max) : undefined, target: flags.worker ? 'worker' : undefined,
      }, 190000));
    case 'reload': return print(await bridge.call('reload_extension'));
    default:
      console.log(USAGE);
  }
}

main().catch(e => { console.error(`Hata: ${e.message}`); process.exitCode = 1; });
