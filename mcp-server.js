'use strict';
// MCP server (stdio, newline-delimited JSON-RPC) that Claude Code starts. It is a thin client:
// every tool call is forwarded to the native host that Chrome runs for the extension.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const identity = require('./identity');
const bridge = require('./shared');

const SERVER_INFO = { name: identity.MCP_NAME, title: identity.PRODUCT, version: bridge.VERSION };
const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reference', 'text_reply']);
// A prompt that asks to change an existing image rather than draw a new one.
const EDIT_INTENT = /\b(edit|modify|retouch|inpaint|change only|only change|keep (everything|it|the rest)|pixel-identical|same (pose|image|drawing|character))\b|düzenle|değiştir|aynı (kalsın|bırak|tut)|koru(yarak)?\b/i;

const INSTRUCTIONS = `Generates images with the user's own ChatGPT account (already logged in in Google Chrome), with no OpenAI API key and no extra cost.
- When the user asks for an image "with ChatGPT" (in any language), call generate_image with a detailed, self-contained prompt.
- To EDIT an image or keep a character consistent, pass the image file(s) in reference_images (e.g. a file saved by an earlier call). A fresh chat with reference_images is the most reliable way to edit; long revision chains via conversation_url make ChatGPT lose track of earlier images.
- Read every result line: NEEDS REFERENCE IMAGE means ChatGPT could not reach the image to edit; CHATGPT REPLIED WITHOUT AN IMAGE shows ChatGPT's own text. Never resend the identical prompt in a loop; follow the next step given in the result.
- An EDIT CHECK warning means ChatGPT drew a new picture instead of editing; tell the user and retry with reference_images in a fresh chat if an exact edit is needed.
- The work happens in a background Chrome tab; never tell the user to switch tabs unless a result says NEEDS USER ACTION.
- NEEDS USER ACTION means ChatGPT shows a login or human-verification (CAPTCHA) page: ask the user to open the ChatGPT tab in Chrome and finish it themselves. Never try to bypass it. The job continues automatically afterwards (check with job_status).
- If no project is selected, call list_projects, then select_project with the user's images project.
- If a job timed out but has a conversation link, fetch_images can still download the result later.
- Report the saved file path(s) and the ChatGPT conversation link to the user.`;

const TOOLS = [
  {
    name: 'generate_image',
    title: 'Generate or edit an image with ChatGPT',
    description:
      "Generate or edit an image with ChatGPT through the user's own logged-in ChatGPT account in Google Chrome (no OpenAI API key, no extra cost). " +
      "A new chat is started inside the user's selected ChatGPT Project, in a background tab: the user's active tab, window focus, mouse and keyboard are never touched. " +
      "Waits for the result and returns: SUCCESS with the saved file path(s) (always kept in the images folder), a preview and the conversation link; " +
      "or NEEDS REFERENCE IMAGE / CHATGPT REPLIED WITHOUT AN IMAGE together with ChatGPT's own reply text. " +
      "Use it whenever the user asks for an image, visual, illustration or concept art with ChatGPT, in any language. " +
      'Write a detailed, self-contained prompt (subject, style, composition, colors, mood, aspect ratio). ' +
      'To edit an image or keep a character consistent, pass the image file(s) in reference_images: a fresh chat with reference_images is the most reliable way to edit.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full image description or edit instructions, in any language.' },
        reference_images: {
          type: 'array', items: { type: 'string' }, maxItems: 4,
          description: 'Optional local image files (png/jpg/webp/gif, up to 4) attached to the message, e.g. the image to edit or a character sheet. Paths saved by earlier calls work directly.',
        },
        conversation_url: {
          type: 'string',
          description: 'Optional ChatGPT conversation link from an earlier result: the prompt is sent in that chat instead of a new one. Fine for quick follow-ups; for exact edits prefer reference_images in a fresh chat.',
        },
        auto_reattach: {
          type: 'boolean', default: false,
          description: "If ChatGPT answers that it can't access the image and asks for it to be uploaded, attach the chat's latest image (or reference_images) automatically and ask once more.",
        },
        output_dir: {
          type: 'string',
          description: "Optional folder to also copy the image(s) into, e.g. the current project's assets folder (absolute path preferred). The central images folder always keeps a copy.",
        },
        wait_seconds: {
          type: 'integer', minimum: 0, maximum: 900, default: 300,
          description: 'How long to wait for the result. If the job is still running after that, use job_status to keep waiting.',
        },
        include_preview: { type: 'boolean', default: true, description: 'Attach a downscaled preview of the result so you can check it.' },
        send_as_is: { type: 'boolean', default: false, description: 'Send the prompt verbatim, without the short instruction the bridge adds (useful to answer a question ChatGPT asked).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'job_status',
    title: 'ChatGPT image job status',
    description:
      'Check a ChatGPT image job by job_id (optionally waiting up to wait_seconds for it to finish). ' +
      'Without job_id it reports the bridge itself: whether Chrome and the extension are connected, the selected ChatGPT project, the images folder, the queue and recent jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'Job id returned by generate_image (e.g. img_1a2b3c4d).' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 900, default: 0, description: 'Wait up to this long for the job to finish.' },
        include_preview: { type: 'boolean', default: true, description: 'Attach the image preview when the job succeeded.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'cancel_job',
    title: 'Cancel a ChatGPT image job',
    description: 'Cancel a queued or running ChatGPT image job. If ChatGPT is already generating, it presses Stop in the background tab and closes that tab.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'Job id to cancel.' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'fetch_images',
    title: 'Fetch images from a ChatGPT conversation',
    description:
      'Download the generated images of the latest answer in an existing ChatGPT conversation (by its link) without sending anything. ' +
      'Use it when a job timed out or failed after ChatGPT had started, but the chat finished later, or to save images from an earlier chat.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_url: { type: 'string', description: 'ChatGPT conversation link (https://chatgpt.com/…/c/…).' },
        output_dir: { type: 'string', description: 'Optional folder to also copy the image(s) into (absolute path preferred).' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 900, default: 180, description: 'How long to wait for the result.' },
        include_preview: { type: 'boolean', default: true, description: 'Attach a downscaled preview.' },
      },
      required: ['conversation_url'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'list_projects',
    title: 'List ChatGPT projects',
    description: "List the Projects in the user's ChatGPT account (read from ChatGPT's sidebar in a background tab) and show which one is selected for images. Use it during setup.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'select_project',
    title: 'Select the ChatGPT project for images',
    description: 'Select and remember the ChatGPT Project where new image chats are created. Pass the project name as shown in ChatGPT (matched loosely) or its https://chatgpt.com/g/g-p-…/project link.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name as shown in ChatGPT.' },
        url: { type: 'string', description: 'Project link (alternative to name).' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

// ---------------------------------------------------------------- JSON-RPC over stdio

function send(msg) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }
function logErr(...args) { process.stderr.write(`[${identity.MCP_NAME}] ${args.join(' ')}\n`); }

async function handle(msg) {
  if (!msg || typeof msg.method !== 'string') return; // responses to requests we never send
  const isRequest = msg.id !== undefined && msg.id !== null;
  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params && msg.params.protocolVersion;
        const protocolVersion = /^\d{4}-\d{2}-\d{2}$/.test(asked || '') ? asked : '2025-06-18';
        return send({ id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } });
      }
      case 'ping': return isRequest && send({ id: msg.id, result: {} });
      case 'tools/list': return send({ id: msg.id, result: { tools: TOOLS } });
      case 'tools/call': {
        const p = msg.params || {};
        const result = await callTool(p.name, p.arguments || {}, p._meta && p._meta.progressToken);
        return send({ id: msg.id, result });
      }
      case 'resources/list': return send({ id: msg.id, result: { resources: [] } });
      case 'prompts/list': return send({ id: msg.id, result: { prompts: [] } });
      default:
        if (isRequest) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    }
  } catch (e) {
    logErr('request failed:', e.stack || e);
    if (isRequest) send({ id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  handle(msg);
});
rl.on('close', () => process.exit(0));

// ---------------------------------------------------------------- tools

const sleep = ms => new Promise(r => setTimeout(r, ms));
const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
function intArg(v, lo, hi, dflt) { const n = Number.isFinite(Number(v)) ? Math.round(Number(v)) : dflt; return Math.min(hi, Math.max(lo, n)); }

async function callTool(name, args, progressToken) {
  try {
    switch (name) {
      case 'generate_image': return await generateImage(args, progressToken);
      case 'job_status': return await jobStatus(args, progressToken);
      case 'cancel_job': return await cancelJob(args);
      case 'fetch_images': return await fetchImages(args, progressToken);
      case 'list_projects': return await listProjects();
      case 'select_project': return await selectProject(args);
      default: return textResult(`Unknown tool: ${name}`, true);
    }
  } catch (e) {
    return textResult(e.code === 'NOT_RUNNING' ? `BRIDGE NOT RUNNING — ${e.message}` : `ERROR — ${e.message}`, true);
  }
}

async function generateImage(args, progressToken) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) return textResult('prompt is required.', true);
  const references = bridge.readReferences(args.reference_images);
  const job = await bridge.call('generate', {
    prompt, references, autoReattach: !!args.auto_reattach, sendAsIs: !!args.send_as_is,
    copyTo: args.output_dir ? path.resolve(String(args.output_dir)) : undefined,
    startUrl: args.conversation_url ? String(args.conversation_url) : undefined,
  }, 60000);
  const done = await waitForJob(job.id, intArg(args.wait_seconds, 0, 900, 300), progressToken);
  return jobResult(await finish(done), args.include_preview !== false);
}

async function fetchImages(args, progressToken) {
  const url = String(args.conversation_url || '').trim();
  if (!url) return textResult('conversation_url is required.', true);
  const copyTo = args.output_dir ? path.resolve(String(args.output_dir)) : undefined;
  const job = await bridge.call('generate', { mode: 'collect', startUrl: url, copyTo });
  const done = await waitForJob(job.id, intArg(args.wait_seconds, 0, 900, 180), progressToken);
  return jobResult(await finish(done), args.include_preview !== false);
}

async function jobStatus(args, progressToken) {
  if (!args.job_id) return bridgeStatus();
  const job = await waitForJob(String(args.job_id).trim(), intArg(args.wait_seconds, 0, 900, 0), progressToken);
  return jobResult(await finish(job), args.include_preview !== false);
}

async function cancelJob(args) {
  const id = String(args.job_id || '').trim();
  if (!id) return textResult('job_id is required.', true);
  await bridge.call('cancel', { jobId: id });
  return jobResult(await waitForJob(id, 25), false);
}

const finish = job => bridge.copyResults(job);

async function waitForJob(jobId, waitSeconds, progressToken) {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = await bridge.call('job', { jobId });
  let tick = 0;
  let lastNote = '';
  let lastSent = 0;
  while (!FINAL.has(job.status) && job.status !== 'needs_human' && Date.now() < deadline) {
    await sleep(1500);
    try {
      job = await bridge.call('job', { jobId });
    } catch (e) {
      if (e.code === 'NOT_RUNNING' || e.code === 'CLOSED') {
        throw new bridge.BridgeError(`Lost the connection to Chrome while job ${jobId} was ${job.status} (${job.message || job.step}). ${bridge.NOT_RUNNING}`, e.code);
      }
      throw e;
    }
    const note = `${job.status}: ${job.message || job.step}`;
    if (progressToken !== undefined && (note !== lastNote || Date.now() - lastSent > 10000)) {
      send({ method: 'notifications/progress', params: { progressToken, progress: ++tick, message: note } });
      lastNote = note;
      lastSent = Date.now();
    }
  }
  return job;
}

function editCheckLines(job) {
  const check = job.editCheck;
  if (!check || !check.results || !check.results.length) return [];
  // Each result is an output image's closest match; judge by the least similar output.
  const worst = check.results.reduce((a, b) => (b.similarity < a.similarity ? b : a));
  const pct = Math.round(worst.similarity * 100);
  if (worst.similarity >= 0.75) return [`Edit check: ${pct}% of the image is unchanged compared with ${worst.against} — this looks like a real edit (edited: true).`];
  if (EDIT_INTENT.test(job.prompt || '')) {
    return [`⚠ EDIT CHECK (edited: false): only ${pct}% of the image matches ${worst.against}. ChatGPT most likely drew a NEW picture instead of editing (a real local edit keeps ~95-100%). ` +
      'Tell the user; if an exact edit is needed, call generate_image again WITHOUT conversation_url and with reference_images=[the original image file].'];
  }
  return [`Similarity to ${worst.against}: ${pct}% (a local edit keeps ~95-100%, a redraw is usually under 60%).`];
}

function jobResult(job, includePreview) {
  const lines = [];
  switch (job.status) {
    case 'succeeded':
      lines.push(`SUCCESS — ChatGPT generated ${job.images.length} image(s). Job ${job.id}.`);
      break;
    case 'needs_reference':
      lines.push(`NEEDS REFERENCE IMAGE — ChatGPT could not access the image it should edit and asked for it to be uploaded again (job ${job.id}).${job.reattached ? ' It still asked after the bridge re-attached the image.' : ''}`,
        'Do NOT resend the same prompt. Next step: call generate_image again with reference_images=[the local file of the image to edit] — most reliable WITHOUT conversation_url (a fresh chat). ' +
        'Alternatively pass auto_reattach=true to let the bridge attach the chat\'s latest image itself.');
      break;
    case 'text_reply':
      lines.push(`CHATGPT REPLIED WITHOUT AN IMAGE (job ${job.id}). Read its reply below and act on it — do not resend the identical prompt. ` +
        'If it asked a question, answer it with generate_image(conversation_url=<the link below>, prompt=<your answer>, send_as_is=true); if it refused, rephrase the request.');
      break;
    case 'failed':
      lines.push(`FAILED — ${job.error || 'unknown error'} (job ${job.id})`);
      break;
    case 'cancelled':
      lines.push(`CANCELLED — job ${job.id}.`);
      break;
    case 'needs_human':
      lines.push(`NEEDS USER ACTION — ${job.message} (job ${job.id})`,
        'Ask the user to open the ChatGPT tab in Chrome and complete it themselves; do not try to bypass it. ' +
        'The job continues automatically for up to 10 minutes; check it with job_status.');
      break;
    case 'queued':
      lines.push(`QUEUED — waiting behind another job (position ${job.queuePosition || '?'}). Job ${job.id}; check it with job_status.`);
      break;
    default:
      lines.push(`STILL RUNNING — ${job.message || job.step}. Job ${job.id}; call job_status with wait_seconds to keep waiting, or cancel_job to stop it.`);
  }
  if (job.conversationUrl) lines.push(`ChatGPT conversation: ${job.conversationUrl}`);
  if (job.references && job.references.length) lines.push(`Reference images attached: ${job.references.map(r => r.name).join(', ')}`);
  if (job.reattached && job.status === 'succeeded') lines.push('Note: ChatGPT first asked for the image again; the bridge re-attached it and asked once more.');
  for (const im of job.images || []) lines.push(`Saved: ${im.path}${im.width ? ` (${im.width}x${im.height})` : ''}`);
  for (const c of job.copies || []) lines.push(`Copied to: ${c}`);
  if (job.copyError) lines.push(`Could not copy into output_dir: ${job.copyError}`);
  lines.push(...editCheckLines(job));
  if (job.assistantText) {
    lines.push(job.status === 'succeeded' ? `ChatGPT's text: ${job.assistantText.slice(0, 1500)}` : `ChatGPT's reply:\n${job.assistantText.slice(0, 3000)}`);
  }
  if (job.chatImages && job.chatImages.length) {
    lines.push('Images already saved from this chat (newest first) — usable as reference_images:');
    for (const im of job.chatImages) lines.push(`- ${im.path}  (${im.job}: "${im.prompt}")`);
  }
  const content = [{ type: 'text', text: lines.join('\n') }];
  if (includePreview && job.status === 'succeeded') {
    for (const im of job.images) {
      try {
        if (im.preview) content.push({ type: 'image', data: fs.readFileSync(im.preview).toString('base64'), mimeType: 'image/jpeg' });
      } catch {}
    }
  }
  return { content, isError: job.status === 'failed' };
}

async function bridgeStatus() {
  let s;
  try {
    s = await bridge.call('status');
  } catch (e) {
    if (e.code === 'NOT_RUNNING') return textResult(`Bridge: NOT RUNNING. ${e.message}`);
    throw e;
  }
  const lines = [
    `Bridge: connected (Chrome extension v${s.extension ? s.extension.version : '?'}, host v${s.hostVersion}).`,
    s.project
      ? `ChatGPT project: ${s.project.name} — ${s.project.url}`
      : 'ChatGPT project: NOT SELECTED — call list_projects, then select_project.',
    `Images folder: ${s.outputDir}`,
    s.running ? `Running: ${s.running.id} — ${s.running.status}: ${s.running.message || s.running.step}` : 'Running: nothing',
    `Queued: ${s.queued.length ? s.queued.join(', ') : 'none'}`,
  ];
  if (s.recent.length) {
    lines.push('Recent jobs:');
    for (const j of s.recent) lines.push(`- ${j.id} ${j.status} (${j.createdAt}) "${j.prompt}"${j.conversationUrl ? ` ${j.conversationUrl}` : ''}`);
  }
  return textResult(lines.join('\n'));
}

async function listProjects() {
  const r = await bridge.call('list_projects', {}, 130000);
  if (!r.projects.length) return textResult('No projects were found in the ChatGPT sidebar.');
  const lines = ['ChatGPT projects:'];
  for (const p of r.projects) {
    const selected = r.selected && (r.selected.id === p.id || r.selected.name === p.name);
    lines.push(`- ${p.name}${p.url ? ` — ${p.url}` : ''}${selected ? '  (selected for images)' : ''}`);
  }
  if (!r.selected) lines.push('No project is selected yet; call select_project.');
  return textResult(lines.join('\n'));
}

async function selectProject(args) {
  if (!args.name && !args.url) return textResult('Give name or url.', true);
  const r = await bridge.call('select_project', { name: args.name, url: args.url }, 130000);
  return textResult(`Selected ChatGPT project "${r.project.name}" (${r.project.url}). New images will be created there and the choice is remembered.`);
}

process.on('uncaughtException', e => logErr('uncaught:', e.stack || e));
process.on('unhandledRejection', e => logErr('unhandled:', (e && e.stack) || e));
