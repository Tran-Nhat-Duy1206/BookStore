"use client";

import {
  motion,
  MotionConfig,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useScroll,
} from "motion/react";
import { type CSSProperties, type ReactNode } from "react";

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig
      reducedMotion="user"
      transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </MotionConfig>
  );
}
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={{ opacity: 1, y: reduced ? 0 : 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1 }}
      transition={{ duration: reduced ? 0 : 0.4, delay: reduced ? 0 : delay }}
      style={{ "--reveal-delay": `${delay}s` } as CSSProperties}
    >
      {children}
    </motion.div>
  );
}
export function BookTilt({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateX = useSpring(x, { stiffness: 210, damping: 25 });
  const rotateY = useSpring(y, { stiffness: 210, damping: 25 });
  return (
    <motion.div
      className={`book-tilt ${className}`}
      data-tilt="true"
      style={{
        rotateX: reduced ? 0 : rotateX,
        rotateY: reduced ? 0 : rotateY,
        transformPerspective: 900,
      }}
      onPointerMove={(event) => {
        if (
          reduced ||
          event.pointerType !== "mouse" ||
          !window.matchMedia("(hover: hover) and (pointer: fine)").matches
        )
          return;
        const rect = event.currentTarget.getBoundingClientRect();
        x.set(-((event.clientY - rect.top) / rect.height - 0.5) * 8);
        y.set(((event.clientX - rect.left) / rect.width - 0.5) * 8);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}
export function AmbientArt({ children }: { children: ReactNode }) {
  const reduced = useReducedMotion();
  const { scrollY } = useScroll();
  const parallax = useTransform(scrollY, [0, 600], [0, 12]);
  const pointer = useMotionValue(0);
  const smooth = useSpring(pointer, { stiffness: 55, damping: 20 });
  const shift = useTransform(smooth, [-1, 1], [-8, 8]);
  return (
    <motion.div
      className="hero-art"
      onPointerMove={(event) => {
        if (!reduced && event.pointerType === "mouse") {
          const r = event.currentTarget.getBoundingClientRect();
          pointer.set(((event.clientX - r.left) / r.width - 0.5) * 2);
        }
      }}
      onPointerLeave={() => pointer.set(0)}
      style={{ x: reduced ? 0 : shift, y: reduced ? 0 : parallax }}
    >
      {children}
    </motion.div>
  );
}
