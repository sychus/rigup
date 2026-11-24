// `rigup completion zsh|bash|fish`: prints a script that completes rigup's commands, and the
// configured sources after `rigup remove`. Sources come from `rigup __complete sources`, which
// only reads the config file (no claude call), so pressing Tab stays instant.

import { loadConfig } from './config.mjs';
import { label } from './sources.mjs';

export const COMMANDS = {
  add: 'Add a source (owner/repo, git URL or folder)',
  remove: 'Remove a source from the config',
  sources: 'List the configured sources',
  setup: 'Apply the config to this machine',
  update: 'Update rigup, every source and every plugin',
  doctor: 'Check this machine against the config',
  changes: 'What changed in your skills',
  list: 'Every skill, agent and command, with its cost',
  search: 'Find skills, agents and commands by topic',
  prune: 'Plugins you did not use lately',
  completion: 'Print a shell completion script',
};
export const SHELLS = ['zsh', 'bash', 'fish'];

/** How each configured source is shown (and accepted by rigup remove). */
export function sourceNames(ctx) {
  return loadConfig(ctx).sources.map(s => label(s.spec, ctx.home));
}

export function completionScript(shell) {
  const names = Object.keys(COMMANDS).join(' ');
  if (shell === 'bash') {
    return `# rigup completion for bash. Add to ~/.bashrc:  source <(rigup completion bash)
_rigup() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${names} --help --version" -- "$cur"))
    return
  fi
  case "\${COMP_WORDS[1]}" in
    remove) COMPREPLY=($(compgen -W "$(rigup __complete sources 2>/dev/null)" -- "$cur")) ;;
    add) COMPREPLY=($(compgen -d -- "$cur")) ;;
    completion) COMPREPLY=($(compgen -W "${SHELLS.join(' ')}" -- "$cur")) ;;
  esac
}
complete -F _rigup rigup`;
  }
  if (shell === 'zsh') {
    const described = Object.entries(COMMANDS).map(([c, d]) => `    '${c}:${d.replace(/'/g, '')}'`).join('\n');
    return `#compdef rigup
# rigup completion for zsh. Add to ~/.zshrc (after compinit):  source <(rigup completion zsh)
_rigup() {
  local -a commands sources
  commands=(
${described}
  )
  if (( CURRENT == 2 )); then
    _describe 'rigup command' commands
    return
  fi
  case $words[2] in
    remove)
      sources=(\${(f)"$(rigup __complete sources 2>/dev/null)"})
      compadd -a sources ;;
    add) _files -/ ;;
    completion) _values 'shell' ${SHELLS.join(' ')} ;;
  esac
}
compdef _rigup rigup`;
  }
  if (shell === 'fish') {
    const lines = Object.entries(COMMANDS).map(([c, d]) => `complete -c rigup -n __fish_use_subcommand -a ${c} -d '${d.replace(/'/g, '')}'`);
    return `# rigup completion for fish:  rigup completion fish > ~/.config/fish/completions/rigup.fish
complete -c rigup -f
${lines.join('\n')}
complete -c rigup -n '__fish_seen_subcommand_from remove' -a '(rigup __complete sources 2>/dev/null)'
complete -c rigup -n '__fish_seen_subcommand_from add' -F
complete -c rigup -n '__fish_seen_subcommand_from completion' -a '${SHELLS.join(' ')}'`;
  }
  return null;
}
