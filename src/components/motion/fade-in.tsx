"use client";

import { motion } from "motion/react";
import type * as React from "react";

interface FadeInProps {
  children: React.ReactNode;
  /** 延迟（秒） */
  delay?: number;
  /** 上移距离（px） */
  y?: number;
  className?: string;
}

/** 统一的入场动效容器（仅做轻量淡入上移，避免过度动效） */
export function FadeIn({ children, delay = 0, y = 10, className }: FadeInProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

interface StaggerListProps {
  children: React.ReactNode;
  className?: string;
  /** 每个子项的间隔（秒） */
  stagger?: number;
  delay?: number;
}

/** 列表逐项入场容器 */
export function StaggerList({
  children,
  className,
  stagger = 0.05,
  delay = 0.04,
}: StaggerListProps) {
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: stagger, delayChildren: delay } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** StaggerList 的子项 */
export function StaggerItem({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0, transition: { duration: 0.32 } },
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
