import { describe, expect, it } from "vitest";
import { gbToDoc } from "../src/books/googleBooks";

describe("gbToDoc", () => {
  it("maps a Google Books volume onto the matcher's doc shape", () => {
    const doc = gbToDoc({
      volumeInfo: {
        title: "Abundance",
        authors: ["Ezra Klein", "Derek Thompson"],
        publishedDate: "2025-03-18",
        pageCount: 304,
        imageLinks: { thumbnail: "http://books.google.com/books/content?id=x&edge=curl&zoom=1" },
      },
    });
    expect(doc.title).toBe("Abundance");
    expect(doc.author_name).toEqual(["Ezra Klein", "Derek Thompson"]);
    expect(doc.first_publish_year).toBe(2025);
    expect(doc.number_of_pages_median).toBe(304);
    expect(doc.gbCoverUrl).toBe("https://books.google.com/books/content?id=x&zoom=1"); // https, no curl
    expect(doc.key).toBeUndefined(); // no OL work key — title-dedup covers GB books
  });

  it("treats missing/zero fields as absent", () => {
    const doc = gbToDoc({ volumeInfo: { title: "X", publishedDate: "n.d.", pageCount: 0 } });
    expect(doc.first_publish_year).toBeUndefined();
    expect(doc.number_of_pages_median).toBeUndefined();
    expect(doc.gbCoverUrl).toBeUndefined();
    expect(gbToDoc({}).title).toBeUndefined();
  });
});

describe("borrowSiblingPages", () => {
  it("fills a missing page count from another edition of the same work", async () => {
    const { borrowSiblingPages } = await import("../src/books/googleBooks");
    const docs = [
      { title: "A Brief History of Intelligence", author_name: ["Max Bennett"] },
      { title: "A Brief History of Intelligence", author_name: ["Max Bennett"], number_of_pages_median: 432 },
      { title: "A Totally Different Book", author_name: ["X"], number_of_pages_median: 99 },
    ];
    const out = borrowSiblingPages(docs as never);
    expect(out[0]!.number_of_pages_median).toBe(432);
    expect(out[2]!.number_of_pages_median).toBe(99);
  });
  it("leaves docs alone when no sibling has pages", async () => {
    const { borrowSiblingPages } = await import("../src/books/googleBooks");
    const docs = [{ title: "Lonely Book", author_name: ["Y"] }];
    expect(borrowSiblingPages(docs as never)[0]!.number_of_pages_median).toBeUndefined();
  });
});
