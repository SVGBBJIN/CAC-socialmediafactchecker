import type { ButtonHTMLAttributes } from "react";
import "./Button.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {}

/** The plain secondary-action button treatment — used for "Retry" after a failed check,
 * and anywhere else outside the sidebar's own accent-styled `.new-check`. */
export function Button({ className, ...rest }: ButtonProps) {
  return <button type="button" className={["retry-button", className].filter(Boolean).join(" ")} {...rest} />;
}
