import { source } from "@/lib/source";
import {
  DocsPage,
  DocsBody,
  DocsTitle,
  DocsDescription,
} from "fumadocs-ui/page";
import { PageFooter } from "fumadocs-ui/layouts/docs/page";
import { notFound, redirect } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { CodeBlock } from "@/components/code-block";
import { DocsPageActions } from "@/components/docs-page-actions";
import {
  readDocsPageMarkdown,
  resolveDocsPageMarkdownPath,
} from "@/lib/docs-markdown";
import { relative } from "node:path";

const docsIndexPath = "/docs/getting-started/introduction";
const docsIndexSlug = ["getting-started", "introduction"] as const;

function isDocsIndex(slug: string[] | undefined) {
  return slug === undefined || slug.length === 0 || slug.join("/") === "";
}

function isHeroPage(slug: string[] | undefined) {
  return slug?.join("/") === "getting-started/introduction";
}

function toRepositoryPath(sourcePath: string) {
  return `docs-site/${relative(process.cwd(), sourcePath).replaceAll("\\", "/")}`;
}

function buildSourceEditUrl(sourcePath: string) {
  return `https://github.com/Kaelio/ktx/edit/main/${toRepositoryPath(sourcePath)}`;
}

function buildIssueUrl(pageTitle: string, sourcePath: string, pageUrl: string) {
  const title = `[docs] ${pageTitle}`;
  const body = [
    `Documentation page: ${pageUrl}`,
    `Source file: ${toRepositoryPath(sourcePath)}`,
    "",
    "What should change?",
    "",
  ].join("\n");

  const params = new URLSearchParams({
    template: "bug_report.yml",
    title,
    body,
  });

  return `https://github.com/Kaelio/ktx/issues/new?${params.toString()}`;
}

export default async function Page(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  if (isDocsIndex(params.slug)) {
    redirect(docsIndexPath);
  }

  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const mdxSource = await readDocsPageMarkdown(page.slugs);
  const sourcePath = await resolveDocsPageMarkdownPath(page.slugs);
  const pageUrl = `https://docs.kaelio.com/ktx/docs/${page.slugs.join("/")}`;

  const hero = isHeroPage(params.slug);

  return (
    <DocsPage
      toc={page.data.toc}
      className="!mx-0 min-w-0 justify-self-start md:!mx-auto"
      footer={{
        component: (
          <>
            <div className="mt-10 mb-4">
              <DocsPageActions
                sourceEditUrl={buildSourceEditUrl(sourcePath)}
                issueUrl={buildIssueUrl(page.data.title, sourcePath, pageUrl)}
              />
            </div>
            <PageFooter />
          </>
        ),
      }}
      style={{
        width: "calc(100vw - 2rem)",
        maxWidth: "900px",
      }}
    >
      {!hero && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <DocsTitle>{page.data.title}</DocsTitle>
            <DocsPageActions mdxSource={mdxSource} />
          </div>
          <DocsDescription className="wrap-anywhere">
            {page.data.description}
          </DocsDescription>
        </>
      )}
      <DocsBody className="min-w-0 max-w-full wrap-anywhere">
        <MDX components={{ ...defaultMdxComponents, pre: CodeBlock }} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return [{ slug: [""] }, ...source.generateParams()];
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}) {
  const params = await props.params;
  const page = source.getPage(
    isDocsIndex(params.slug) ? [...docsIndexSlug] : params.slug,
  );
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
