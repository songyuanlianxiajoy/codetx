/**
 * shell 补全脚本生成。
 */
const COMMANDS = [
  'exec',
  'resume',
  'sessions',
  'login',
  'logout',
  'config',
  'relay',
  'doctor',
  'completion',
  'update',
  'help',
  'version',
];

export function completionScript(shell) {
  switch (shell) {
    case 'bash':
      return bashScript();
    case 'zsh':
      return zshScript();
    case 'fish':
      return fishScript();
    default:
      throw new Error(`不支持的 shell：${shell}（可选 bash / zsh / fish）`);
  }
}

function bashScript() {
  return `# codetx bash completion
_codetx_complete() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="${COMMANDS.join(' ')}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$cur") )
    return 0
  fi

  case "\$prev" in
    relay)
      COMPREPLY=( \$(compgen -W "use on off status models test list" -- "\$cur") )
      return 0
      ;;
    config)
      COMPREPLY=( \$(compgen -W "get set list path edit" -- "\$cur") )
      return 0
      ;;
    completion)
      COMPREPLY=( \$(compgen -W "bash zsh fish" -- "\$cur") )
      return 0
      ;;
    --approvals)
      COMPREPLY=( \$(compgen -W "ask auto full read-only" -- "\$cur") )
      return 0
      ;;
    --type)
      COMPREPLY=( \$(compgen -W "openai responses" -- "\$cur") )
      return 0
      ;;
    --model|-m)
      return 0
      ;;
    -C|--cd)
      COMPREPLY=( \$(compgen -d -- "\$cur") )
      return 0
      ;;
  esac

  case "\$cur" in
    -*)
      COMPREPLY=( \$(compgen -W "--model --provider --cd --approvals --full-auto --read-only --json --quiet --output-last-message --continue --session --probe --offline --verbose --help --version --no-color" -- "\$cur") )
      return 0
      ;;
  esac
  return 0
}
complete -F _codetx_complete codetx
`;
}

function zshScript() {
  return `#compdef codetx
_codetx() {
  local -a commands
  commands=(
    'exec:非交互执行一轮任务'
    'resume:恢复历史会话'
    'sessions:列出会话'
    'login:配置 API 端点'
    'logout:清除本地凭证'
    'config:读写配置'
    'relay:中转站切换'
    'doctor:环境自检'
    'completion:生成补全脚本'
    'update:git pull 升级'
    'help:帮助'
    'version:版本'
  )
  _arguments -C \\
    '(-m --model)'{-m,--model}'[模型]:model:' \\
    '(-p --provider)'{-p,--provider}'[provider]:provider:' \\
    '(-C --cd)'{-C,--cd}'[工作目录]:dir:_files -/' \\
    '--approvals[审批策略]:policy:(ask auto full read-only)' \\
    '(-h --help)'{-h,--help}'[帮助]' \\
    '(-V --version)'{-V,--version}'[版本]' \\
    '1:command:->command' \\
    '*::args:->args'
  case $state in
    command) _describe 'command' commands ;;
    args)
      case $words[2] in
        relay) _values 'relay' use on off status models test list ;;
        config) _values 'config' get set list path edit ;;
        completion) _values 'shell' bash zsh fish ;;
      esac
      ;;
  esac
}
_codetx "$@"
`;
}

function fishScript() {
  return `# codetx fish completion
complete -c codetx -f
complete -c codetx -n '__fish_use_subcommand' -a '${COMMANDS.join(' ')}'
complete -c codetx -n '__fish_seen_subcommand_from relay' -a 'use on off status models test list'
complete -c codetx -n '__fish_seen_subcommand_from config' -a 'get set list path edit'
complete -c codetx -n '__fish_seen_subcommand_from completion' -a 'bash zsh fish'
complete -c codetx -l model -d '模型'
complete -c codetx -l provider -d 'provider 名'
complete -c codetx -l cd -d '工作目录'
complete -c codetx -l approvals -a 'ask auto full read-only' -d '审批策略'
complete -c codetx -l full-auto -d '全部自动放行'
complete -c codetx -l read-only -d '只读模式'
complete -c codetx -l json -d 'exec 输出 JSON 事件'
complete -c codetx -l continue -d '继续最近会话'
complete -c codetx -l help -d '帮助'
complete -c codetx -l version -d '版本'
`;
}
