'use strict';
// Every name the outside world sees, in one place. The extension can't load this file, so
// extension/background.js repeats HOST_NAME (a test keeps the two in sync).
module.exports = {
  PRODUCT: 'Backdraw',
  HOST_NAME: 'io.github.muhammedtalha04.backdraw',
  HOST_DESCRIPTION: 'Backdraw native host',
  MCP_NAME: 'backdraw',
  PIPE_PREFIX: 'backdraw', // the pipe is named <prefix>-<user>
  PIPE_ENV: 'BACKDRAW_PIPE', // pipe path override, tests only
  INSTALL_DIR_NAME: '.backdraw', // in the user's home folder
  IMAGES_DIR_NAME: 'Backdraw', // in the user's Pictures folder, for new installs

  // Names used before the rename; install.js migrates from them and cleans them up.
  LEGACY: {
    HOST_NAME: 'com.claude.chatgpt_image_bridge',
    MCP_NAME: 'chatgpt-images',
    INSTALL_DIR: ['.claude', 'chatgpt-image-bridge'], // relative to the home folder
  },
};
