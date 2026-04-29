import React from "react"

type Props = {
  className?: string
  size?: number | string
  ariaLabel?: string
}

export const Logo: React.FC<Props> = ({ className, size, ariaLabel = "Stohr" }) => {
  const fontSize = size != null
    ? (typeof size === "number" ? `${Math.round(size * 0.55)}px` : size)
    : undefined
  const cls = `wordmark${className ? ` ${className}` : ""}`
  return (
    <span
      className={cls}
      aria-label={ariaLabel}
      role="img"
      style={fontSize ? { fontSize } : undefined}
    >
      stohr
    </span>
  )
}
