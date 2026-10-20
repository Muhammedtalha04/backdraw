'use strict';
// The message the host sends to ChatGPT for a job.

// The wording nudges ChatGPT to call its image tool instead of asking questions first.
function buildText(job) {
  if (job.sendAsIs) return job.prompt;
  if (job.references && job.references.length) {
    const what = job.references.length > 1 ? 'The attached images are references' : 'The attached image is the reference';
    return `${what}. Follow the instructions below; when they ask for an edit, change only what is asked and keep everything else identical. Don't ask follow-up questions; generate the image directly.\n\n${job.prompt}`;
  }
  if (job.startUrl && /\/c\/[0-9a-f-]{8,}/i.test(job.startUrl)) {
    return `Update the image with the changes below and generate the new image directly, without follow-up questions.\n\n${job.prompt}`;
  }
  return `Generate an image from the description below. Don't ask follow-up questions; create the image directly.\n\n${job.prompt}`;
}

module.exports = { buildText };
