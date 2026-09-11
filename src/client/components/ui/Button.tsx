import React from "react";
import { Icon, type IconName } from "./Icon.js";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
};

export function Button({ variant = "secondary", icon, className = "", children, type = "button", ...props }: Props) {
  return <button type={type} className={`ui-button ui-button--${variant} ${className}`} {...props}>{icon && <Icon name={icon} />}{children}</button>;
}

export function IconButton({ label, icon, className = "", ...props }: Omit<Props, "children" | "icon"> & { label: string; icon: IconName }) {
  return <Button variant="ghost" {...props} icon={icon} aria-label={label} title={label} className={`ui-icon-button ${className}`} />;
}
