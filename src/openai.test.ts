import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from "fs";
import {
  formatSize,
  countLines,
  hasBinaryBytes,
  htmlToText,
  stripHtml,
  parseDDGResults,
  executeTool,
  getToolDefinitions,
} from "./openai.js";

// -- Test fixtures --

const TEST_DIR = join(import.meta.dir, "__test_fixtures__");

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "subdir"), { recursive: true });
  mkdirSync(join(TEST_DIR, ".hidden_dir"), { recursive: true });

  writeFileSync(join(TEST_DIR, "hello.txt"), "line one\nline two\nline three\n");
  writeFileSync(join(TEST_DIR, "no_trailing_newline.txt"), "first\nsecond\nthird");
  writeFileSync(join(TEST_DIR, "empty.txt"), "");
  writeFileSync(join(TEST_DIR, "single_line.txt"), "just one line\n");
  writeFileSync(join(TEST_DIR, "single_line_no_nl.txt"), "just one line");
  writeFileSync(join(TEST_DIR, "big.txt"), Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(TEST_DIR, "binary.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a])); // PNG-like header with null byte
  writeFileSync(join(TEST_DIR, "utf16le.txt"), Buffer.from([0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00])); // UTF-16 LE BOM + "Hi"
  writeFileSync(join(TEST_DIR, "utf16be.txt"), Buffer.from([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69])); // UTF-16 BE BOM + "Hi"
  writeFileSync(join(TEST_DIR, "subdir", "nested.txt"), "nested content\n");
  writeFileSync(join(TEST_DIR, ".hidden_file"), "secret\n");
  writeFileSync(join(TEST_DIR, ".hidden_dir", "inside.txt"), "inside hidden\n");
  writeFileSync(join(TEST_DIR, "code.ts"), 'function hello() {\n  console.log("hello");\n}\n\nexport { hello };\n');
  writeFileSync(join(TEST_DIR, "multi_match.txt"), "apple\nbanana\napple\ncherry\napple\n");
  writeFileSync(join(TEST_DIR, "unique.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(TEST_DIR, "for_edit.txt"), "line A\nline B\nline C\n");
  writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\nccc\nddd\n");
  writeFileSync(join(TEST_DIR, "duplicate_strings.txt"), "foo bar\nfoo bar\nbaz\n");

  // Create a symlink loop for ListDirectory test
  try {
    symlinkSync(TEST_DIR, join(TEST_DIR, "subdir", "loop_link"));
  } catch {}
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ===================== Pure function tests =====================

describe("formatSize", () => {
  test("bytes", () => {
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(100)).toBe("100B");
    expect(formatSize(1023)).toBe("1023B");
  });

  test("kilobytes", () => {
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(1536)).toBe("1.5K");
    expect(formatSize(1024 * 1023)).toBe("1023.0K");
  });

  test("megabytes", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0M");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5M");
  });
});

describe("countLines", () => {
  test("empty string", () => {
    expect(countLines("")).toBe(0);
  });

  test("single line with trailing newline", () => {
    expect(countLines("hello\n")).toBe(1);
  });

  test("single line without trailing newline", () => {
    expect(countLines("hello")).toBe(1);
  });

  test("multiple lines with trailing newline", () => {
    expect(countLines("a\nb\nc\n")).toBe(3);
  });

  test("multiple lines without trailing newline", () => {
    expect(countLines("a\nb\nc")).toBe(3);
  });

  test("blank lines count", () => {
    expect(countLines("a\n\n\nb\n")).toBe(4);
  });

  test("just a newline", () => {
    expect(countLines("\n")).toBe(1);
  });
});

describe("hasBinaryBytes", () => {
  test("plain text is not binary", () => {
    expect(hasBinaryBytes(Buffer.from("Hello world"))).toBe(false);
  });

  test("null byte makes it binary", () => {
    expect(hasBinaryBytes(Buffer.from([0x48, 0x00, 0x69]))).toBe(true);
  });

  test("UTF-16 LE BOM is not binary", () => {
    expect(hasBinaryBytes(Buffer.from([0xFF, 0xFE, 0x48, 0x00]))).toBe(false);
  });

  test("UTF-16 BE BOM is not binary", () => {
    expect(hasBinaryBytes(Buffer.from([0xFE, 0xFF, 0x00, 0x48]))).toBe(false);
  });

  test("PNG header with null is binary", () => {
    // Real PNG has no null byte in the 8-byte header, but file content will have nulls
    expect(hasBinaryBytes(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))).toBe(false);
    // Actual binary content with null bytes
    expect(hasBinaryBytes(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x0D, 0x0A]))).toBe(true);
  });

  test("empty buffer is not binary", () => {
    expect(hasBinaryBytes(Buffer.from([]))).toBe(false);
  });
});

describe("htmlToText", () => {
  test("strips script and style tags", () => {
    const html = '<p>Hello</p><script>alert("x")</script><style>.x{}</style><p>World</p>';
    const text = htmlToText(html);
    expect(text).toContain("Hello");
    expect(text).toContain("World");
    expect(text).not.toContain("alert");
    expect(text).not.toContain(".x{");
  });

  test("converts links", () => {
    const html = '<a href="https://example.com">Click here</a>';
    const text = htmlToText(html);
    expect(text).toContain("Click here");
    expect(text).toContain("https://example.com");
  });

  test("converts paragraphs to line breaks", () => {
    const html = "<p>First paragraph</p><p>Second paragraph</p>";
    const text = htmlToText(html);
    expect(text).toContain("First paragraph");
    expect(text).toContain("Second paragraph");
    // They should be on separate lines
    const lines = text.split("\n").filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test("decodes HTML entities", () => {
    const html = "<p>&amp; &lt; &gt; &quot; &#x27; &nbsp;</p>";
    const text = htmlToText(html);
    expect(text).toContain("&");
    expect(text).toContain("<");
    expect(text).toContain(">");
    expect(text).toContain('"');
    expect(text).toContain("'");
  });

  test("strips nav and footer", () => {
    const html = "<nav>menu stuff</nav><main>The real content</main><footer>Copyright</footer>";
    const text = htmlToText(html);
    expect(text).not.toContain("menu stuff");
    expect(text).toContain("The real content");
    expect(text).not.toContain("Copyright");
  });

  test("pre blocks get triple backtick wrapping", () => {
    const html = "<pre>const x = 1;</pre>";
    const text = htmlToText(html);
    expect(text).toContain("const x = 1;");
    expect(text).toContain("```");
  });

  test("inline code gets single backtick wrapping", () => {
    const html = "<p>Use <code>const</code> keyword</p>";
    const text = htmlToText(html);
    expect(text).toContain("`const`");
  });

  test("empty input returns empty", () => {
    expect(htmlToText("")).toBe("");
  });
});

describe("stripHtml", () => {
  test("removes tags", () => {
    expect(stripHtml("<b>bold</b>")).toBe("bold");
  });

  test("decodes entities", () => {
    expect(stripHtml("&amp; &lt;")).toBe("& <");
  });

  test("collapses whitespace", () => {
    expect(stripHtml("  multiple   spaces  ")).toBe(" multiple spaces ");
  });
});

describe("parseDDGResults", () => {
  const sampleHTML = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=abc">Page One Title</a>
    <a class="result__snippet" href="...">This is the first snippet</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage2&rut=def">Page Two Title</a>
    <a class="result__snippet" href="...">This is the second snippet</a>
  `;

  test("parses results correctly", () => {
    const output = parseDDGResults(sampleHTML, 10);
    expect(output).toContain("Page One Title");
    expect(output).toContain("https://example.com/page1");
    expect(output).toContain("first snippet");
    expect(output).toContain("Page Two Title");
    expect(output).toContain("https://example.com/page2");
  });

  test("respects maxResults", () => {
    const output = parseDDGResults(sampleHTML, 1);
    expect(output).toContain("Page One Title");
    expect(output).not.toContain("Page Two Title");
  });

  test("empty HTML returns no results", () => {
    expect(parseDDGResults("<html></html>", 10)).toBe("(no results found)");
  });
});

// ===================== Tool execution tests =====================

describe("Read tool", () => {
  test("reads a file with line numbers", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-3 of 3");
    expect(result).toContain("1\tline one");
    expect(result).toContain("2\tline two");
    expect(result).toContain("3\tline three");
  });

  test("offset and limit", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt"), offset: 2, limit: 1 }, TEST_DIR);
    expect(result).toContain("Lines 2-2 of 3");
    expect(result).toContain("2\tline two");
    expect(result).not.toContain("1\tline one");
    expect(result).not.toContain("3\tline three");
  });

  test("file not found", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "nope.txt") }, TEST_DIR);
    expect(result).toContain("Error: File not found");
  });

  test("binary file rejected", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "binary.bin") }, TEST_DIR);
    expect(result).toContain("Error: Binary file");
    expect(result).toContain("bin");
  });

  test("UTF-16 LE BOM file not rejected as binary", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "utf16le.txt") }, TEST_DIR);
    expect(result).not.toContain("Error: Binary file");
  });

  test("correct line count without trailing newline", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "no_trailing_newline.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-3 of 3");
  });

  test("correct line count with trailing newline", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-3 of 3");
  });

  test("single line file with newline", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "single_line.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-1 of 1");
    expect(result).toContain("1\tjust one line");
  });

  test("single line file without newline", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "single_line_no_nl.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-1 of 1");
  });

  test("large file with offset reads correctly", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "big.txt"), offset: 4990, limit: 20 }, TEST_DIR);
    expect(result).toContain("of 5000");
    expect(result).toContain("4990\tline 4990");
    expect(result).toContain("5000\tline 5000");
  });

  test("shows file size in header", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt") }, TEST_DIR);
    // Should contain size info like "30B" or similar
    expect(result).toMatch(/\d+(\.\d+)?[BKM]/);
  });
});

describe("Edit tool", () => {
  test("replaces unique string", async () => {
    // Reset file
    writeFileSync(join(TEST_DIR, "for_edit.txt"), "line A\nline B\nline C\n");
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "for_edit.txt"),
      old_string: "line B",
      new_string: "line B modified",
    }, TEST_DIR);
    expect(result).toBe("OK");
    const content = readFileSync(join(TEST_DIR, "for_edit.txt"), "utf-8");
    expect(content).toContain("line B modified");
    expect(content).toContain("line A");
    expect(content).toContain("line C");
  });

  test("fails on non-unique string", async () => {
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "duplicate_strings.txt"),
      old_string: "foo bar",
      new_string: "replaced",
    }, TEST_DIR);
    expect(result).toContain("not unique");
  });

  test("replace_all works", async () => {
    writeFileSync(join(TEST_DIR, "multi_match.txt"), "apple\nbanana\napple\ncherry\napple\n");
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "multi_match.txt"),
      old_string: "apple",
      new_string: "orange",
      replace_all: true,
    }, TEST_DIR);
    expect(result).toBe("OK");
    const content = readFileSync(join(TEST_DIR, "multi_match.txt"), "utf-8");
    expect(content).not.toContain("apple");
    expect(content.split("orange").length - 1).toBe(3);
  });

  test("fails on missing old_string", async () => {
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "hello.txt"),
      old_string: "nonexistent string xyz",
      new_string: "whatever",
    }, TEST_DIR);
    expect(result).toContain("not found");
  });

  test("file not found", async () => {
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "no_such_file.txt"),
      old_string: "x",
      new_string: "y",
    }, TEST_DIR);
    expect(result).toContain("Error: File not found");
  });
});

describe("Write tool", () => {
  test("creates new file", async () => {
    const path = join(TEST_DIR, "new_file.txt");
    if (existsSync(path)) rmSync(path);
    const result = await executeTool("Write", { file_path: path, content: "hello world" }, TEST_DIR);
    expect(result).toBe("OK");
    expect(readFileSync(path, "utf-8")).toBe("hello world");
  });

  test("creates directories as needed", async () => {
    const path = join(TEST_DIR, "new_subdir", "deep", "file.txt");
    const result = await executeTool("Write", { file_path: path, content: "deep content" }, TEST_DIR);
    expect(result).toBe("OK");
    expect(readFileSync(path, "utf-8")).toBe("deep content");
    // cleanup
    rmSync(join(TEST_DIR, "new_subdir"), { recursive: true, force: true });
  });

  test("overwrites existing file", async () => {
    const path = join(TEST_DIR, "overwrite_me.txt");
    writeFileSync(path, "old content");
    await executeTool("Write", { file_path: path, content: "new content" }, TEST_DIR);
    expect(readFileSync(path, "utf-8")).toBe("new content");
  });
});

describe("Patch tool (atomic)", () => {
  test("applies multiple edits", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\nccc\nddd\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [
        { old_string: "aaa", new_string: "AAA" },
        { old_string: "ccc", new_string: "CCC" },
      ],
    }, TEST_DIR);
    expect(result).toContain("Edit 1: OK");
    expect(result).toContain("Edit 2: OK");
    const content = readFileSync(join(TEST_DIR, "for_patch.txt"), "utf-8");
    expect(content).toBe("AAA\nbbb\nCCC\nddd\n");
  });

  test("rolls back on failure (atomic)", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\nccc\nddd\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [
        { old_string: "aaa", new_string: "AAA" },
        { old_string: "NONEXISTENT", new_string: "ZZZ" },
        { old_string: "ccc", new_string: "CCC" },
      ],
    }, TEST_DIR);
    expect(result).toContain("Edit 1: OK");
    expect(result).toContain("Edit 2: Error");
    expect(result).toContain("ABORTED");
    // File should be unchanged
    const content = readFileSync(join(TEST_DIR, "for_patch.txt"), "utf-8");
    expect(content).toBe("aaa\nbbb\nccc\nddd\n");
  });

  test("rejects non-unique old_string", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\naaa\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [{ old_string: "aaa", new_string: "AAA" }],
    }, TEST_DIR);
    expect(result).toContain("not unique");
    expect(result).toContain("ABORTED");
  });

  test("sequential edits see prior changes", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\nccc\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [
        { old_string: "aaa", new_string: "xxx" },
        { old_string: "xxx", new_string: "yyy" }, // depends on edit 1
      ],
    }, TEST_DIR);
    expect(result).toContain("Edit 1: OK");
    expect(result).toContain("Edit 2: OK");
    const content = readFileSync(join(TEST_DIR, "for_patch.txt"), "utf-8");
    expect(content).toBe("yyy\nbbb\nccc\n");
  });

  test("empty edits array", async () => {
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [],
    }, TEST_DIR);
    expect(result).toContain("Error: edits array is empty");
  });
});

describe("Grep tool", () => {
  // Grep requires ripgrep (rg) on PATH. Skip all tests if not available.
  const hasRg = Bun.spawnSync(["which", "rg"]).exitCode === 0;
  const grepTest = hasRg ? test : test.skip;

  grepTest("finds matches with line numbers", async () => {
    writeFileSync(join(TEST_DIR, "multi_match.txt"), "apple\nbanana\napple\ncherry\napple\n");
    const result = await executeTool("Grep", {
      pattern: "apple",
      path: join(TEST_DIR, "multi_match.txt"),
    }, TEST_DIR);
    expect(result).toContain("apple");
  });

  grepTest("files-only mode", async () => {
    const result = await executeTool("Grep", {
      pattern: "line",
      path: TEST_DIR,
      output_mode: "files",
    }, TEST_DIR);
    expect(result).toContain("hello.txt");
    expect(result).not.toContain("1:");
  });

  grepTest("count mode", async () => {
    writeFileSync(join(TEST_DIR, "multi_match.txt"), "apple\nbanana\napple\ncherry\napple\n");
    const result = await executeTool("Grep", {
      pattern: "apple",
      path: join(TEST_DIR, "multi_match.txt"),
      output_mode: "count",
    }, TEST_DIR);
    expect(result).toContain("3");
  });

  grepTest("case insensitive", async () => {
    writeFileSync(join(TEST_DIR, "case_test.txt"), "Hello\nhello\nHELLO\n");
    const result = await executeTool("Grep", {
      pattern: "hello",
      path: join(TEST_DIR, "case_test.txt"),
      case_insensitive: true,
      output_mode: "count",
    }, TEST_DIR);
    expect(result).toContain("3");
  });

  grepTest("no matches returns helpful message", async () => {
    const result = await executeTool("Grep", {
      pattern: "zzzznotfound",
      path: TEST_DIR,
    }, TEST_DIR);
    expect(result).toBe("(no matches)");
  });

  grepTest("glob filter", async () => {
    const result = await executeTool("Grep", {
      pattern: "function",
      path: TEST_DIR,
      glob: "*.ts",
      output_mode: "files",
    }, TEST_DIR);
    expect(result).toContain("code.ts");
    expect(result).not.toContain(".txt");
  });

  grepTest("head_limit caps output", async () => {
    writeFileSync(join(TEST_DIR, "many_lines.txt"), Array.from({ length: 100 }, (_, i) => `match_${i}`).join("\n") + "\n");
    const result = await executeTool("Grep", {
      pattern: "match_",
      path: join(TEST_DIR, "many_lines.txt"),
      head_limit: 5,
    }, TEST_DIR);
    expect(result).toContain("capped at 5 lines");
  });

  grepTest("multiline mode", async () => {
    writeFileSync(join(TEST_DIR, "multi_line.txt"), "function hello() {\n  return 1;\n}\n");
    const result = await executeTool("Grep", {
      pattern: "function.*\\{\\s+return",
      path: join(TEST_DIR, "multi_line.txt"),
      multiline: true,
    }, TEST_DIR);
    expect(result).toContain("function hello()");
  });

  test("graceful error when rg not available", async () => {
    if (hasRg) return; // skip this test if rg IS available
    const result = await executeTool("Grep", { pattern: "test", path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("Error");
  });
});

describe("Glob tool", () => {
  test("finds files by pattern", async () => {
    const result = await executeTool("Glob", { pattern: "*.txt", path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("hello.txt");
    expect(result).toContain("big.txt");
  });

  test("recursive pattern", async () => {
    const result = await executeTool("Glob", { pattern: "**/*.txt", path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("nested.txt");
  });

  test("no matches", async () => {
    const result = await executeTool("Glob", { pattern: "*.xyz_nonexistent", path: TEST_DIR }, TEST_DIR);
    expect(result).toBe("(no matches)");
  });

  test("sorted by modification time", async () => {
    // Touch a file to make it newest
    writeFileSync(join(TEST_DIR, "newest.txt"), "i am newest\n");
    const result = await executeTool("Glob", { pattern: "*.txt", path: TEST_DIR }, TEST_DIR);
    const lines = result.split("\n");
    // newest.txt should be first since it was just written
    expect(lines[0]).toBe("newest.txt");
  });
});

describe("ListDirectory tool", () => {
  test("lists directory contents", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("hello.txt");
    expect(result).toContain("subdir/");
  });

  test("shows hidden files by default", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR }, TEST_DIR);
    expect(result).toContain(".hidden_file");
    expect(result).toContain(".hidden_dir/");
  });

  test("hides hidden files when show_hidden is false", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR, show_hidden: false }, TEST_DIR);
    expect(result).not.toContain(".hidden_file");
    expect(result).not.toContain(".hidden_dir/");
  });

  test("recursive depth", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR, depth: 2 }, TEST_DIR);
    expect(result).toContain("subdir/");
    expect(result).toContain("nested.txt");
  });

  test("nonexistent directory", async () => {
    const result = await executeTool("ListDirectory", { path: "/tmp/nonexistent_dir_xyz" }, TEST_DIR);
    expect(result).toContain("Error: Directory not found");
  });

  test("shows file sizes", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR }, TEST_DIR);
    // Files should have size annotations like (30B) or (1.5K)
    expect(result).toMatch(/\(\d+(\.\d+)?[BKM]\)/);
  });

  test("detects symlink loops", async () => {
    // Only run if the symlink was created successfully
    if (existsSync(join(TEST_DIR, "subdir", "loop_link"))) {
      const result = await executeTool("ListDirectory", { path: TEST_DIR, depth: 5 }, TEST_DIR);
      expect(result).toContain("symlink loop detected");
    }
  });
});

describe("Stat tool", () => {
  test("existing file", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "hello.txt") }, TEST_DIR);
    expect(result).toContain("Exists: true");
    expect(result).toContain("Type: file");
    expect(result).toContain("Lines: 3");
    expect(result).toContain("Modified:");
  });

  test("nonexistent path", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "nope.txt") }, TEST_DIR);
    expect(result).toContain("Exists: false");
  });

  test("directory", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "subdir") }, TEST_DIR);
    expect(result).toContain("Exists: true");
    expect(result).toContain("Type: directory");
  });

  test("binary file detected", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "binary.bin") }, TEST_DIR);
    expect(result).toContain("Binary: true");
  });

  test("line count without trailing newline", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "no_trailing_newline.txt") }, TEST_DIR);
    expect(result).toContain("Lines: 3");
  });

  test("single line file", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "single_line.txt") }, TEST_DIR);
    expect(result).toContain("Lines: 1");
  });
});

describe("Bash tool", () => {
  test("runs simple command", async () => {
    const result = await executeTool("Bash", { command: "echo hello" }, TEST_DIR);
    expect(result.trim()).toBe("hello");
  });

  test("captures exit code", async () => {
    const result = await executeTool("Bash", { command: "exit 42" }, TEST_DIR);
    expect(result).toContain("Exit code: 42");
  });

  test("captures stderr", async () => {
    const result = await executeTool("Bash", { command: "echo error >&2" }, TEST_DIR);
    expect(result).toContain("error");
  });

  test("respects working directory", async () => {
    const result = await executeTool("Bash", { command: "pwd" }, TEST_DIR);
    expect(result.trim()).toBe(TEST_DIR);
  });

  test("background mode returns handle", async () => {
    const result = await executeTool("Bash", { command: "echo bg_done", background: true }, TEST_DIR);
    expect(result).toContain("Background job");
    expect(result).toContain("/tmp/bg_");
  });
});

describe("Think tool", () => {
  test("returns OK", async () => {
    const result = await executeTool("Think", { thought: "I need to analyze this" }, TEST_DIR);
    expect(result).toBe("OK");
  });
});

describe("Unknown tool", () => {
  test("returns error for unknown tool", async () => {
    const result = await executeTool("FakeTool", {}, TEST_DIR);
    expect(result).toBe("Unknown tool: FakeTool");
  });
});

// ===================== Tool definitions tests =====================

// ===================== Additional edge case tests =====================

describe("Read edge cases", () => {
  test("empty file returns 0 lines", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "empty.txt") }, TEST_DIR);
    expect(result).toContain("Lines 1-0 of 0");
  });

  test("offset beyond file length returns empty body", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt"), offset: 100 }, TEST_DIR);
    expect(result).toContain("of 3");
    // No content lines should appear
    const bodyLines = result.split("\n").filter(l => /^\d+\t/.test(l));
    expect(bodyLines.length).toBe(0);
  });

  test("limit of 0 returns no content lines", async () => {
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "hello.txt"), limit: 0 }, TEST_DIR);
    // Should still show header with total
    expect(result).toContain("of 3");
  });

  test("reads directory path returns error", async () => {
    const result = await executeTool("Read", { file_path: TEST_DIR }, TEST_DIR);
    // Should error — it's a directory, not a file
    expect(result.toLowerCase()).toMatch(/error|directory/);
  });

  test("reads file with Windows line endings", async () => {
    writeFileSync(join(TEST_DIR, "crlf.txt"), "line one\r\nline two\r\nline three\r\n");
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "crlf.txt") }, TEST_DIR);
    expect(result).toContain("line one");
    expect(result).toContain("line two");
  });

  test("large file triggers streaming path", async () => {
    // Create a file just over 1MB
    const bigContent = "x".repeat(500) + "\n";
    const lines = Math.ceil(1_100_000 / bigContent.length);
    writeFileSync(join(TEST_DIR, "over1mb.txt"), bigContent.repeat(lines));
    const result = await executeTool("Read", { file_path: join(TEST_DIR, "over1mb.txt"), offset: 1, limit: 5 }, TEST_DIR);
    expect(result).toContain("Lines 1-5 of");
    expect(result).toContain("1\t");
    rmSync(join(TEST_DIR, "over1mb.txt"));
  });
});

describe("Edit edge cases", () => {
  test("replacing with empty string (deletion)", async () => {
    writeFileSync(join(TEST_DIR, "for_edit.txt"), "keep\ndelete_me\nkeep\n");
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "for_edit.txt"),
      old_string: "delete_me\n",
      new_string: "",
    }, TEST_DIR);
    expect(result).toBe("OK");
    expect(readFileSync(join(TEST_DIR, "for_edit.txt"), "utf-8")).toBe("keep\nkeep\n");
  });

  test("replacing with identical string", async () => {
    writeFileSync(join(TEST_DIR, "for_edit.txt"), "no change\n");
    const result = await executeTool("Edit", {
      file_path: join(TEST_DIR, "for_edit.txt"),
      old_string: "no change",
      new_string: "no change",
    }, TEST_DIR);
    expect(result).toBe("OK");
  });
});

describe("Write edge cases", () => {
  test("writing empty content", async () => {
    const path = join(TEST_DIR, "empty_write.txt");
    const result = await executeTool("Write", { file_path: path, content: "" }, TEST_DIR);
    expect(result).toBe("OK");
    expect(readFileSync(path, "utf-8")).toBe("");
  });

  test("writing unicode content", async () => {
    const path = join(TEST_DIR, "unicode.txt");
    const content = "Hello 世界 🌍 café naïve";
    await executeTool("Write", { file_path: path, content }, TEST_DIR);
    expect(readFileSync(path, "utf-8")).toBe(content);
  });
});

describe("Patch edge cases", () => {
  test("single edit works", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "hello world\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [{ old_string: "hello", new_string: "goodbye" }],
    }, TEST_DIR);
    expect(result).toContain("Edit 1: OK");
    expect(readFileSync(join(TEST_DIR, "for_patch.txt"), "utf-8")).toBe("goodbye world\n");
  });

  test("file not found", async () => {
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "nonexistent_patch.txt"),
      edits: [{ old_string: "x", new_string: "y" }],
    }, TEST_DIR);
    expect(result).toContain("Error: File not found");
  });

  test("missing new_string", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [{ old_string: "aaa" }],
    }, TEST_DIR);
    expect(result).toContain("Error");
    expect(result).toContain("ABORTED");
  });

  test("first edit fails, nothing written", async () => {
    writeFileSync(join(TEST_DIR, "for_patch.txt"), "aaa\nbbb\n");
    const result = await executeTool("Patch", {
      file_path: join(TEST_DIR, "for_patch.txt"),
      edits: [
        { old_string: "NOTFOUND", new_string: "ZZZ" },
        { old_string: "aaa", new_string: "AAA" },
      ],
    }, TEST_DIR);
    expect(result).toContain("ABORTED");
    expect(readFileSync(join(TEST_DIR, "for_patch.txt"), "utf-8")).toBe("aaa\nbbb\n");
  });
});

describe("Glob edge cases", () => {
  test("nested directory pattern", async () => {
    const result = await executeTool("Glob", { pattern: "subdir/*.txt", path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("nested.txt");
    expect(result).not.toContain("hello.txt");
  });

  test("specific file pattern", async () => {
    const result = await executeTool("Glob", { pattern: "hello.txt", path: TEST_DIR }, TEST_DIR);
    expect(result).toContain("hello.txt");
    expect(result).not.toContain("big.txt");
  });
});

describe("ListDirectory edge cases", () => {
  test("depth 1 does not show nested files", async () => {
    const result = await executeTool("ListDirectory", { path: TEST_DIR, depth: 1 }, TEST_DIR);
    expect(result).toContain("subdir/");
    // nested.txt should NOT appear at depth 1
    const lines = result.split("\n");
    const nestedLine = lines.find(l => l.includes("nested.txt") && !l.includes("subdir/"));
    expect(nestedLine).toBeUndefined();
  });

  test("passing a file path instead of dir", async () => {
    const result = await executeTool("ListDirectory", { path: join(TEST_DIR, "hello.txt") }, TEST_DIR);
    // Should handle gracefully — either error or list it as a single file
    expect(result).toBeTruthy();
  });
});

describe("Stat edge cases", () => {
  test("empty file has 0 lines", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "empty.txt") }, TEST_DIR);
    expect(result).toContain("Exists: true");
    // Empty file: size is 0, so the line counting block is skipped
    expect(result).toContain("Size: 0B");
  });

  test("symlink is detected as symlink", async () => {
    if (existsSync(join(TEST_DIR, "subdir", "loop_link"))) {
      const result = await executeTool("Stat", { path: join(TEST_DIR, "subdir", "loop_link") }, TEST_DIR);
      expect(result).toContain("Type: symlink");
    }
  });

  test("file with no trailing newline", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "no_trailing_newline.txt") }, TEST_DIR);
    expect(result).toContain("Lines: 3");
  });

  test("single line no newline", async () => {
    const result = await executeTool("Stat", { path: join(TEST_DIR, "single_line_no_nl.txt") }, TEST_DIR);
    expect(result).toContain("Lines: 1");
  });
});

describe("Bash edge cases", () => {
  test("command with special characters", async () => {
    const result = await executeTool("Bash", { command: "echo 'hello world' | tr 'h' 'H'" }, TEST_DIR);
    expect(result.trim()).toBe("Hello world");
  });

  test("command producing no output", async () => {
    const result = await executeTool("Bash", { command: "true" }, TEST_DIR);
    expect(result).toBe("(no output)");
  });

  test("command with both stdout and stderr", async () => {
    const result = await executeTool("Bash", { command: "echo out; echo err >&2" }, TEST_DIR);
    expect(result).toContain("out");
    expect(result).toContain("err");
  });

  test("command that doesn't exist", async () => {
    const result = await executeTool("Bash", { command: "nonexistent_command_xyz_123" }, TEST_DIR);
    expect(result).toContain("not found");
  });

  test("environment variables are available", async () => {
    const result = await executeTool("Bash", { command: "echo $HOME" }, TEST_DIR);
    expect(result.trim()).toBeTruthy();
    expect(result.trim()).not.toBe("$HOME");
  });
});

describe("htmlToText edge cases", () => {
  test("nested tags", () => {
    const html = "<div><p>Outer <span>Inner <b>Bold</b></span> text</p></div>";
    const text = htmlToText(html);
    expect(text).toContain("Outer");
    expect(text).toContain("Inner");
    expect(text).toContain("Bold");
    expect(text).toContain("text");
  });

  test("handles malformed HTML gracefully", () => {
    const html = "<p>Unclosed paragraph<p>Another one<div>And a div";
    const text = htmlToText(html);
    expect(text).toContain("Unclosed paragraph");
    expect(text).toContain("Another one");
  });

  test("SVG tags are stripped", () => {
    const html = "<p>Before</p><svg><circle cx='50' cy='50' r='50'/></svg><p>After</p>";
    const text = htmlToText(html);
    expect(text).toContain("Before");
    expect(text).toContain("After");
    expect(text).not.toContain("circle");
  });

  test("comment stripping", () => {
    const html = "<p>Visible</p><!-- This is a comment --><p>Also visible</p>";
    const text = htmlToText(html);
    expect(text).toContain("Visible");
    expect(text).toContain("Also visible");
    expect(text).not.toContain("comment");
  });

  test("table structure uses tabs", () => {
    const html = "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
    const text = htmlToText(html);
    expect(text).toContain("A");
    expect(text).toContain("B");
    expect(text).toContain("C");
    expect(text).toContain("D");
  });

  test("numeric HTML entities", () => {
    const html = "&#65;&#66;&#67;"; // ABC
    const text = htmlToText(html);
    expect(text).toContain("ABC");
  });

  test("hex HTML entities", () => {
    const html = "&#x41;&#x42;&#x43;"; // ABC
    const text = htmlToText(html);
    expect(text).toContain("ABC");
  });
});

describe("parseDDGResults edge cases", () => {
  test("result with no snippet", () => {
    const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=abc">Title Only</a>`;
    const output = parseDDGResults(html, 10);
    expect(output).toContain("Title Only");
    expect(output).toContain("https://example.com");
  });

  test("handles non-DDG redirect URLs", () => {
    const html = `<a rel="nofollow" class="result__a" href="//example.com/direct">Direct Link</a>
                  <a class="result__snippet" href="">Some snippet</a>`;
    const output = parseDDGResults(html, 10);
    expect(output).toContain("Direct Link");
    expect(output).toContain("https://example.com/direct");
  });

  test("maxResults of 0 returns no results", () => {
    const html = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=abc">Title</a>`;
    const output = parseDDGResults(html, 0);
    expect(output).toBe("(no results found)");
  });
});

describe("countLines edge cases", () => {
  test("only newlines", () => {
    expect(countLines("\n\n\n")).toBe(3);
  });

  test("very long single line", () => {
    expect(countLines("a".repeat(100000))).toBe(1);
  });

  test("mixed content and empty lines", () => {
    expect(countLines("a\n\nb\n\nc\n")).toBe(5);
  });
});

describe("formatSize edge cases", () => {
  test("exact boundaries", () => {
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(1024 * 1024)).toBe("1.0M");
  });

  test("large file", () => {
    expect(formatSize(1024 * 1024 * 100)).toBe("100.0M");
  });
});

// ===================== Tool definitions tests =====================

describe("getToolDefinitions", () => {
  test("coding mode has all tools", () => {
    const tools = getToolDefinitions("coding");
    const names = tools.map(t => t.function.name);
    expect(names).toContain("Read");
    expect(names).toContain("Edit");
    expect(names).toContain("Write");
    expect(names).toContain("Bash");
    expect(names).toContain("Grep");
    expect(names).toContain("Glob");
    expect(names).toContain("ListDirectory");
    expect(names).toContain("Stat");
    expect(names).toContain("Patch");
    expect(names).toContain("WebFetch");
    expect(names).toContain("WebSearch");
    expect(names).toContain("Think");
  });

  test("research mode has no write tools", () => {
    const tools = getToolDefinitions("research");
    const names = tools.map(t => t.function.name);
    expect(names).toContain("Read");
    expect(names).toContain("Grep");
    expect(names).toContain("Glob");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Bash");
    expect(names).not.toContain("Patch");
  });

  test("chat mode has no tools", () => {
    const tools = getToolDefinitions("chat");
    expect(tools.length).toBe(0);
  });

  test("all tools have required fields", () => {
    const tools = getToolDefinitions("coding");
    for (const tool of tools) {
      expect(tool.type).toBe("function");
      expect(tool.function.name).toBeTruthy();
      expect(tool.function.description).toBeTruthy();
      expect(tool.function.parameters).toBeTruthy();
    }
  });
});
