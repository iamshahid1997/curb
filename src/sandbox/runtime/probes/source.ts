/**
 * Static facts about the component source.
 *
 * Runs in the sandbox because Babel already lives there. It is a pure function
 * of the source text — no DOM — and exists to supply the half of the
 * correlation rules that runtime probing cannot see. Whether an aria-live
 * region sits inside a memo boundary, or whether an animation is guarded by
 * prefers-reduced-motion, is a property of the code, not of the rendered tree.
 */

import * as Babel from "@babel/standalone";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface ImportFact {
  source: string;
  specifiers: string[];
  isNamespace: boolean;
  /** Named imports from a package that ships one module per export. */
  barrelRisk: boolean;
}

export interface AriaLiveFact {
  value: string;
  /** True when this region is rendered inside a memoised boundary. */
  insideMemo: boolean;
  ownerComponent: string | null;
}

export interface LoadingStateFact {
  /** The state variable gating this branch, e.g. "saving". */
  identifier: string;
  /** Text rendered while it is truthy. */
  rendersText: string[];
  hasAriaBusy: boolean;
  hasAriaLive: boolean;
}

export interface ImageFact {
  src: string | null;
  loading: string | null;
  hasAlt: boolean;
  altValue: string | null;
}

export interface SourceFacts {
  componentNames: string[];
  imports: ImportFact[];
  /** Components wrapped in memo / useMemo / forwardRef+memo. */
  memoized: Array<{ name: string; kind: string }>;
  ariaLive: AriaLiveFact[];
  ariaBusyCount: number;
  loadingStates: LoadingStateFact[];
  images: ImageFact[];
  contentVisibility: string[];
  virtualizationLibs: string[];
  animations: Array<{ from: "style" | "className"; value: string }>;
  reducedMotionGuard: boolean;
  indexKeys: number;
  parseError: string | null;
}

/* -------------------------------------------------------------------------- */
/* Heuristics                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Packages where a named import commonly pulls the whole set unless the
 * bundler can tree-shake it. Not exhaustive, and deliberately conservative —
 * a false "your bundle is huge" is worse than a missed one.
 */
const BARREL_PACKAGES = [
  "lucide-react",
  "react-icons",
  "@mui/icons-material",
  "@mui/material",
  "@ant-design/icons",
  "antd",
  "react-bootstrap",
  "lodash",
  "@material-ui/core",
  "@material-ui/icons",
];

const VIRTUALIZATION_LIBS = [
  "react-window",
  "react-virtualized",
  "@tanstack/react-virtual",
  "react-virtuoso",
];

const LOADING_IDENTIFIER = /^(is)?(loading|saving|pending|busy|submitting|fetching|updating)$/i;
const SKELETON_TEXT = /(loading|saving|submitting|please wait|updating|fetching|…|\.\.\.)/i;

/* -------------------------------------------------------------------------- */
/* Analysis                                                                   */
/* -------------------------------------------------------------------------- */

type Node = Record<string, unknown>;

function attrName(attr: Node): string | null {
  const name = attr.name as Node | undefined;
  if (!name) return null;
  if (name.type === "JSXIdentifier") return String(name.name);
  if (name.type === "JSXNamespacedName") {
    const ns = name.namespace as Node;
    const id = name.name as Node;
    return `${String(ns.name)}:${String(id.name)}`;
  }
  return null;
}

function attrStringValue(attr: Node): string | null {
  const value = attr.value as Node | null;
  if (!value) return null;
  if (value.type === "StringLiteral") return String(value.value);
  if (value.type === "JSXExpressionContainer") {
    const expr = value.expression as Node;
    if (expr?.type === "StringLiteral") return String(expr.value);
    if (expr?.type === "TemplateLiteral") {
      const quasis = expr.quasis as Node[];
      return quasis.map((q) => String((q.value as Node).raw ?? "")).join("${…}");
    }
  }
  return null;
}

function elementName(node: Node): string {
  const opening = (node.openingElement ?? node) as Node;
  const name = opening.name as Node | undefined;
  if (!name) return "unknown";
  if (name.type === "JSXIdentifier") return String(name.name);
  if (name.type === "JSXMemberExpression") {
    const obj = name.object as Node;
    const prop = name.property as Node;
    return `${String(obj.name ?? "?")}.${String(prop.name ?? "?")}`;
  }
  return "unknown";
}

export function analyzeSource(source: string): SourceFacts {
  const facts: SourceFacts = {
    componentNames: [],
    imports: [],
    memoized: [],
    ariaLive: [],
    ariaBusyCount: 0,
    loadingStates: [],
    images: [],
    contentVisibility: [],
    virtualizationLibs: [],
    animations: [],
    reducedMotionGuard: false,
    indexKeys: 0,
    parseError: null,
  };

  facts.reducedMotionGuard = /prefers-reduced-motion|useReducedMotion|motion-safe|motion-reduce/i.test(
    source,
  );

  const memoizedNames = new Set<string>();

  const collector = () => ({
    visitor: {
      ImportDeclaration(path: { node: Node }) {
        const node = path.node;
        const src = String((node.source as Node).value);
        const specs = (node.specifiers as Node[]) ?? [];

        const named = specs
          .filter((s) => s.type === "ImportSpecifier")
          .map((s) => {
            const imported = s.imported as Node;
            return String(imported.name ?? imported.value ?? "?");
          });

        const isNamespace = specs.some((s) => s.type === "ImportNamespaceSpecifier");

        facts.imports.push({
          source: src,
          specifiers: named,
          isNamespace,
          barrelRisk:
            named.length > 0 && BARREL_PACKAGES.some((p) => src === p || src.startsWith(`${p}/`)),
        });

        if (VIRTUALIZATION_LIBS.some((lib) => src === lib || src.startsWith(`${lib}/`))) {
          facts.virtualizationLibs.push(src);
        }
      },

      FunctionDeclaration(path: { node: Node }) {
        const id = path.node.id as Node | null;
        const name = id ? String(id.name) : "";
        if (name && /^[A-Z]/.test(name)) facts.componentNames.push(name);
      },

      VariableDeclarator(path: { node: Node }) {
        const id = path.node.id as Node;
        if (id?.type !== "Identifier") return;
        const name = String(id.name);
        if (!/^[A-Z]/.test(name)) return;

        const init = path.node.init as Node | null;
        if (!init) return;

        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          facts.componentNames.push(name);
          return;
        }

        if (init.type === "CallExpression") {
          const callee = init.callee as Node;
          const calleeName =
            callee.type === "Identifier"
              ? String(callee.name)
              : callee.type === "MemberExpression"
                ? String((callee.property as Node).name)
                : "";

          if (/^(memo|forwardRef)$/.test(calleeName)) {
            facts.componentNames.push(name);
            if (calleeName === "memo") {
              facts.memoized.push({ name, kind: "memo" });
              memoizedNames.add(name);
            }
          }
        }
      },

      JSXAttribute(path: { node: Node; findParent?: unknown }) {
        const node = path.node;
        const name = attrName(node);
        if (!name) return;

        if (name === "aria-busy") facts.ariaBusyCount += 1;

        if (name === "aria-live") {
          facts.ariaLive.push({
            value: attrStringValue(node) ?? "polite",
            // Filled in below once we know which components are memoised.
            insideMemo: false,
            ownerComponent: null,
          });
        }

        if (name === "key") {
          const value = node.value as Node | null;
          if (value?.type === "JSXExpressionContainer") {
            const expr = value.expression as Node;
            if (expr?.type === "Identifier" && /^(i|idx|index)$/i.test(String(expr.name))) {
              facts.indexKeys += 1;
            }
          }
        }

        if (name === "style") {
          const raw = JSON.stringify(node.value ?? {});
          if (/contentVisibility|content-visibility/.test(raw)) {
            facts.contentVisibility.push(raw.slice(0, 120));
          }
          if (/animation|transition/i.test(raw)) {
            facts.animations.push({ from: "style", value: raw.slice(0, 120) });
          }
        }

        if (name === "className") {
          const value = attrStringValue(node);
          if (value && /animate-|transition-|duration-/.test(value)) {
            facts.animations.push({ from: "className", value });
          }
          if (value && /content-visibility|content-visibility-auto/.test(value)) {
            facts.contentVisibility.push(value);
          }
        }
      },

      JSXElement(path: { node: Node }) {
        const node = path.node;
        const tag = elementName(node);
        if (tag !== "img" && tag !== "Image") return;

        const opening = node.openingElement as Node;
        const attrs = (opening.attributes as Node[]) ?? [];

        let src: string | null = null;
        let loading: string | null = null;
        let hasAlt = false;
        let altValue: string | null = null;

        for (const attr of attrs) {
          if (attr.type !== "JSXAttribute") continue;
          const name = attrName(attr);
          if (name === "src") src = attrStringValue(attr);
          if (name === "loading") loading = attrStringValue(attr);
          if (name === "alt") {
            hasAlt = true;
            altValue = attrStringValue(attr);
          }
        }

        facts.images.push({ src, loading, hasAlt, altValue });
      },

      LogicalExpression(path: { node: Node }) {
        const node = path.node;
        if (node.operator !== "&&") return;

        const left = node.left as Node;
        if (left?.type !== "Identifier") return;
        const identifier = String(left.name);
        if (!LOADING_IDENTIFIER.test(identifier)) return;

        const right = node.right as Node;
        const rendered = JSON.stringify(right ?? {});

        const texts: string[] = [];
        const matches = rendered.match(/"value":"([^"]{2,80})"/g) ?? [];
        for (const m of matches) {
          const text = m.replace(/"value":"/, "").replace(/"$/, "").trim();
          if (text && SKELETON_TEXT.test(text)) texts.push(text);
        }

        facts.loadingStates.push({
          identifier,
          rendersText: texts,
          hasAriaBusy: /aria-busy/.test(rendered),
          hasAriaLive: /aria-live|role":"status|role":"alert/.test(rendered),
        });
      },
    },
  });

  try {
    Babel.transform(source, {
      filename: "Component.tsx",
      sourceType: "module",
      presets: [["react", { runtime: "classic" }], "typescript"],
      plugins: [collector],
      code: false,
    });
  } catch (err) {
    facts.parseError = err instanceof Error ? err.message : String(err);
  }

  // A single-component file is the common case, so a memo anywhere in it means
  // the aria-live regions in it are inside a memo boundary.
  if (facts.memoized.length > 0) {
    for (const region of facts.ariaLive) {
      region.insideMemo = true;
      region.ownerComponent = facts.memoized[0].name;
    }
  }

  return facts;
}
