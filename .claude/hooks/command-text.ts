// Shared helper for the Bash-guard hooks: strip literal text (heredoc bodies,
// quoted strings) from a shell command before pattern-matching it. A commit
// message or echoed doc that merely MENTIONS a flag or protected file must not
// trip a guard — only real command syntax (flags, redirects, path arguments)
// should, and that is never inside quotes/heredocs.
export function stripLiterals(cmd: string): string {
  return (
    cmd
      // heredoc bodies: <<EOF / <<'EOF' / <<-EOF … up to the terminator line
      .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\2\b/g, "<<stripped")
      // double-quoted strings (with escapes)
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      // single-quoted strings
      .replace(/'[^']*'/g, "''")
  );
}
