// Markdown for text people write in the panel (service notes). Rendered by
// react-markdown, which builds React elements and never injects HTML: raw
// HTML in the text shows as text, and link URLs other than http(s), mailto
// and relative ones are dropped (its default urlTransform). Images become
// links, so opening notes never loads anything from another host.

import { CodeBlock } from "@seylo/ui/components/code-block";
import { cn } from "@seylo/ui/lib/utils";
import type { ComponentProps } from "react";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** The text of a hast node and everything under it. */
function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/** "yaml" for a fence opened with ```yaml (remark gives its code element class "language-yaml"). */
function fenceLanguage(pre: HastNode | undefined): string | undefined {
  const code = pre?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes : typeof classes === "string" ? classes.split(" ") : [];
  const language = list.find((c): c is string => typeof c === "string" && c.startsWith("language-"));
  return language?.slice("language-".length) || undefined;
}

const components: Components = {
  h1: ({ node: _, ...props }) => <h3 className="mt-5 mb-2 text-[17px] font-semibold text-foreground first:mt-0" {...props} />,
  h2: ({ node: _, ...props }) => <h4 className="mt-5 mb-2 text-[15px] font-semibold text-foreground first:mt-0" {...props} />,
  h3: ({ node: _, ...props }) => <h5 className="mt-4 mb-1.5 text-[14px] font-semibold text-foreground first:mt-0" {...props} />,
  h4: ({ node: _, ...props }) => <h6 className="mt-4 mb-1.5 text-[13.5px] font-semibold text-foreground first:mt-0" {...props} />,
  h5: ({ node: _, ...props }) => <h6 className="mt-3 mb-1 text-[13px] font-semibold text-foreground first:mt-0" {...props} />,
  h6: ({ node: _, ...props }) => <h6 className="mt-3 mb-1 text-[13px] font-semibold text-muted-foreground first:mt-0" {...props} />,
  p: ({ node: _, ...props }) => <p className="my-2 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node: _, ...props }) => <ul className="my-2 list-disc pl-5 marker:text-ink-faint" {...props} />,
  ol: ({ node: _, ...props }) => <ol className="my-2 list-decimal pl-5 marker:text-ink-faint" {...props} />,
  li: ({ node: _, ...props }) => <li className="my-0.5 [&>input]:mr-1.5 [&>input]:align-middle" {...props} />,
  a: ({ node: _, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="text-link underline-offset-2 hover:text-link-hover hover:underline"
      {...props}
    />
  ),
  // No remote images: show the alt text as a link to the image instead.
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline-offset-2 hover:underline">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  blockquote: ({ node: _, ...props }) => <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground" {...props} />,
  hr: () => <hr className="my-4 border-0 border-t border-divider" />,
  code: ({ node: _, className, ...props }) => (
    <code className={cn("rounded-chip bg-muted px-1 py-px font-mono text-[12.5px] text-foreground", className)} {...props} />
  ),
  // Fenced code: the kit's code block, so long lines wrap and it has a copy button.
  pre: ({ node }) => (
    <CodeBlock
      className="my-2"
      tone="dark"
      title={fenceLanguage(node as HastNode | undefined)}
      code={textOf(node as HastNode | undefined).replace(/\n$/, "")}
    />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => <th className="border-b border-border px-2.5 py-1.5 text-left font-semibold text-ink-strong" {...props} />,
  td: ({ node: _, ...props }) => <td className="border-b border-divider px-2.5 py-1.5 align-top" {...props} />,
};

/** Drops every URL scheme but http(s), mailto and relative links. */
export function safeUrl(url: string): string {
  return defaultUrlTransform(url);
}

export function Markdown({ children, className, ...rest }: { children: string } & Omit<ComponentProps<"div">, "children">) {
  return (
    <div className={cn("min-w-0 text-[13.5px] leading-relaxed text-card-foreground [overflow-wrap:anywhere]", className)} {...rest}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
