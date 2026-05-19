import React, { useMemo } from "react"

type Tok = { type: string; value: string }
type Rule = { type: string; re: RegExp }

const tokenize = (src: string, rules: Rule[]): Tok[] => {
  const out: Tok[] = []
  let i = 0
  const flush = (type: string, value: string) => {
    const last = out[out.length - 1]
    if (last && last.type === type) last.value += value
    else out.push({ type, value })
  }
  while (i < src.length) {
    let matched = false
    const tail = src.slice(i)
    for (const r of rules) {
      const m = tail.match(r.re)
      if (m) {
        flush(r.type, m[0])
        i += m[0].length
        matched = true
        break
      }
    }
    if (!matched) {
      flush("plain", src[i]!)
      i++
    }
  }
  return out
}

const RULES_TS: Rule[] = [
  { type: "comment", re: /^\/\/[^\n]*|^\/\*[\s\S]*?\*\// },
  { type: "string", re: /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'|^`(?:[^`\\]|\\.)*`/ },
  { type: "number", re: /^\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/ },
  { type: "keyword", re: /^\b(?:const|let|var|function|async|await|if|else|for|while|return|import|export|from|as|type|interface|class|new|true|false|null|undefined|of|in|throw|try|catch|finally|switch|case|break|continue|do|extends|implements|enum|public|private|protected|static|readonly|void|never|any|unknown)\b/ },
  { type: "builtin", re: /^\b(?:process|fetch|console|JSON|Array|Object|Map|Set|Promise|Date|Number|String|Boolean|Error|Math|globalThis|window|document|localStorage|crypto|Buffer)\b/ },
  { type: "punctuation", re: /^[{}[\]().,;:?]/ },
  { type: "operator", re: /^=>|^[+\-*/%=<>!&|^~]+/ },
]

const RULES_BASH: Rule[] = [
  { type: "comment", re: /^#[^\n]*/ },
  { type: "string", re: /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/ },
  { type: "variable", re: /^\$\{[^}]+\}|^\$[A-Za-z_][A-Za-z0-9_]*/ },
  { type: "flag", re: /^--?[A-Za-z][A-Za-z0-9_-]*/ },
  { type: "number", re: /^\b\d+\b/ },
  { type: "operator", re: /^&&|^\|\||^[|&;]/ },
]

const RULES_JSON: Rule[] = [
  { type: "comment", re: /^\/\/[^\n]*|^\/\*[\s\S]*?\*\// },
  { type: "key", re: /^"(?:[^"\\]|\\.)*"(?=\s*:)/ },
  { type: "string", re: /^"(?:[^"\\]|\\.)*"/ },
  { type: "number", re: /^-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/ },
  { type: "keyword", re: /^\b(?:true|false|null)\b/ },
  { type: "punctuation", re: /^[{}[\]:,]/ },
]

const highlight = (src: string, lang: string | undefined): Tok[] => {
  const l = (lang ?? "").toLowerCase()
  if (l === "ts" || l === "tsx" || l === "js" || l === "javascript" || l === "typescript") return tokenize(src, RULES_TS)
  if (l === "bash" || l === "sh" || l === "shell") return tokenize(src, RULES_BASH)
  if (l === "json") return tokenize(src, RULES_JSON)
  return [{ type: "plain", value: src }]
}

export const CodeBlock: React.FC<{ children: string; lang?: string }> = ({ children, lang }) => {
  const toks = useMemo(() => highlight(children, lang), [children, lang])
  return (
    <pre className="devp-code" data-lang={lang}>
      <code>
        {toks.map((t, i) =>
          t.type === "plain"
            ? <React.Fragment key={i}>{t.value}</React.Fragment>
            : <span key={i} className={`tk tk-${t.type}`}>{t.value}</span>
        )}
      </code>
    </pre>
  )
}
