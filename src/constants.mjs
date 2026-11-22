// Fixed facts rigup relies on. Everything about *your* setup lives in the config file instead.

// Node 22 is the oldest LTS still supported (until April 2027).
export const MIN_NODE_MAJOR = 22;

// `claude plugin install --json` and `marketplace list --json` with `installLocation` need 2.1.292.
export const MIN_CLAUDE_VERSION = '2.1.292';

// Paths inside a marketplace or plugin folder, as Claude Code defines them.
export const CATALOG_PATH = '.claude-plugin/marketplace.json';
export const PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';
export const COMPONENT_DIRS = ['skills', 'agents', 'commands'];

// File a plugin may ship at its root to declare what it needs (see README).
export const REQUIREMENTS_FILE = 'requirements.json';

// The marketplace rigup generates for local folders that are not marketplaces themselves.
// Claude Code only accepts plugin sources inside the marketplace folder ("./..."), so rigup
// links (or copies) each folder in there.
export const LOCAL_MARKETPLACE = 'rigup-local';

// Variables that switch off the plugin auto-update pass, and the one that overrides them.
export const UPDATE_DISABLING_VARS = ['DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'];
export const FORCE_PLUGIN_UPDATES_VAR = 'FORCE_AUTOUPDATE_PLUGINS';

// git without prompts: background updates cannot answer one, so neither does rigup.
export const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' };
