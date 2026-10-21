'use strict';
// Limits shared by the host, the MCP server, the CLI and (copied by hand) the extension.

// Reference images attached to one ChatGPT message, counting reference_images and collection images
// together. ChatGPT's composer accepted 16 attachments in one message in a test; provisional until a
// generation with that many references has been checked.
const MAX_REFS = 16;
// Largest single reference image.
const MAX_REF_BYTES = 20 * 1024 * 1024;
// All references of one message together: the extension hands them to the page in one call, and 16
// large photos would pass Chrome's message limits. No more than the old limit allowed (4 x 20 MB).
const MAX_REFS_TOTAL_BYTES = 80 * 1024 * 1024;
// Largest image a reference collection keeps (extension/collections.js repeats it). Larger than
// MAX_REF_BYTES: such an image stays in the collection but is left out of jobs.
const MAX_COLLECTION_BYTES = 25 * 1024 * 1024;

module.exports = { MAX_REFS, MAX_REF_BYTES, MAX_REFS_TOTAL_BYTES, MAX_COLLECTION_BYTES };
