import { Resvg } from "@resvg/resvg-js";

const AVATAR_SIZE = 256;

const SVG_PROMPT = `Generate an SVG image to use as a profile avatar based on the description below.

Requirements:
- Output ONLY valid SVG markup — no explanation, no markdown fences, no other text
- The SVG must use xmlns="http://www.w3.org/2000/svg"
- Use a square viewBox (e.g. viewBox="0 0 256 256")
- Keep the design simple, bold, and recognizable at small sizes (it will be a chat avatar)
- Use vibrant colors
- Do not use external images, fonts, or links

Description: `;

export async function generateAvatar(description: string): Promise<Uint8Array> {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const proc = Bun.spawn(
    ["claude", "-p", "--model", "sonnet", "--no-session-persistence"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env,
    }
  );

  proc.stdin!.write(SVG_PROMPT + description);
  proc.stdin!.end();

  const output = await new Response(proc.stdout).text();
  await proc.exited;

  // Extract SVG from the output (Claude might wrap it in markdown fences)
  const svg = extractSvg(output);
  if (!svg) {
    throw new Error("Claude didn't return valid SVG");
  }

  // Convert SVG to PNG
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: AVATAR_SIZE },
  });
  return resvg.render().asPng();
}

function extractSvg(text: string): string | null {
  // Try to find SVG between tags
  const match = text.match(/<svg[\s\S]*<\/svg>/i);
  if (match) return match[0];

  // Try stripping markdown fences
  const stripped = text.replace(/```(?:xml|svg|html)?\n?/g, "").replace(/```/g, "").trim();
  const match2 = stripped.match(/<svg[\s\S]*<\/svg>/i);
  if (match2) return match2[0];

  return null;
}
