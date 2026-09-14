import React from "react";
import { Icon, type IconName } from "./Icon.js";
import { Tooltip } from "./Tooltip.js";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
};

// forwardRef：Tooltip 用 cloneElement 注入 ref 需要能拿到底层 button DOM。
export const Button = React.forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", icon, className = "", children, type = "button", ...props },
  ref,
) {
  return <button ref={ref} type={type} className={`ui-button ui-button--${variant} ${className}`} {...props}>{icon && <Icon name={icon} />}{children}</button>;
});

// IconButton：icon-only 按钮，用共享 Tooltip 替代原生 title 提示。
// label 同时作为 aria-label（无障碍）与 Tooltip 内容；移除 title={label} 消除系统默认慢 tooltip。
export const IconButton = React.forwardRef<HTMLButtonElement, Omit<Props, "children" | "icon"> & { label: string; icon: IconName }>(function IconButton(
  { label, icon, className = "", ...props },
  ref,
) {
  const btn = <Button ref={ref} variant="ghost" {...props} icon={icon} aria-label={label} className={`ui-icon-button ${className}`} />;
  return <Tooltip content={label}>{btn}</Tooltip>;
});
