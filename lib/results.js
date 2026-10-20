'use strict';
// The text lines of a tool result for a job. Pure (no file or bridge access) so every status can
// be tested; mcp-server.js adds the preview images.
const { intArg } = require('./args');

const FINAL = new Set(['succeeded', 'failed', 'cancelled', 'needs_reference', 'text_reply']);
// Each tool call returns within this many seconds by default: some clients that reach the PC from
// the cloud give up on a tool call after 60 s, and generating takes 1-3 minutes.
const DEFAULT_WAIT = 45;
// How long a tool call may wait for its job: wait_seconds as whole seconds within 0-900.
const waitSeconds = args => intArg(args.wait_seconds, 0, 900, DEFAULT_WAIT);
const checkAgain = id => `Call job_status with job_id="${id}" and wait_seconds=${DEFAULT_WAIT} again (repeat until it finishes), or cancel_job to stop it.`;
// A prompt that asks to change an existing image rather than draw a new one.
const EDIT_INTENT = /\b(edit(s|ed|ing)?|modif(y|ies|ied|ying)|retouch(es|ed|ing)?|inpaint(s|ed|ing)?|change only|only change|change [a-z ]{1,30} only|keep (everything|it|the rest)|pixel-identical|same (pose|image|drawing|character))\b|düzenle|değiştir|aynı (kalsın|bırak|tut)|koru(yarak)?\b/i;

function editCheckLines(job) {
  const check = job.editCheck;
  if (!check || !check.results || !check.results.length) return [];
  // Each result is an output image's closest match; judge by the least similar output.
  const worst = check.results.reduce((a, b) => (b.similarity < a.similarity ? b : a));
  // Judged on the shown percentage, so the verdict never contradicts the number next to it.
  const pct = Math.round(worst.similarity * 100);
  if (pct >= 75) return [`Edit check: ${pct}% of the image is unchanged compared with ${worst.against} — this looks like a real edit (edited: true).`];
  if (EDIT_INTENT.test(job.prompt || '')) {
    return [`⚠ EDIT CHECK (edited: false): only ${pct}% of the image matches ${worst.against}. ChatGPT most likely drew a NEW picture instead of editing (a real local edit keeps ~95-100%). ` +
      'Tell the user; if an exact edit is needed, call generate_image again WITHOUT conversation_url and with reference_images=[the original image file].'];
  }
  return [`Similarity to ${worst.against}: ${pct}% (a local edit keeps ~95-100%, a redraw is usually under 60%).`];
}

function resultLines(job) {
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
        `The job continues automatically for up to 10 minutes; check it with job_status(job_id="${job.id}", wait_seconds=${DEFAULT_WAIT}).`);
      break;
    case 'queued':
      lines.push(`QUEUED — position ${job.queuePosition || '?'} in the queue (position 1 starts as soon as the running job, if any, is done). Job ${job.id}. ${checkAgain(job.id)}`);
      break;
    default:
      lines.push(`STILL RUNNING — ${job.message || job.step}. Job ${job.id}. ${checkAgain(job.id)}`);
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
  return lines;
}

module.exports = { FINAL, DEFAULT_WAIT, EDIT_INTENT, waitSeconds, editCheckLines, resultLines };
