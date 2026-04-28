import React from "react"
import logoUrl from "./assets/logo.png"

type Props = {
  className?: string
  size?: number | string
  ariaLabel?: string
}

export const Logo: React.FC<Props> = ({ className, size, ariaLabel = "Stohr" }) => {
  const style = size != null ? { height: typeof size === "number" ? `${size}px` : size, width: "auto" } : undefined
  return <img src={logoUrl} alt={ariaLabel} className={className} style={style} />
}
