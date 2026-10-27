import { describe, expect, it } from "vitest";
import { fromRawFunding, monthRange, parseFundingCsv, parseKlineCsv, snapHour, toMs } from "../src/data/parse.js";
import { matchSpot } from "../src/data/symbols.js";

describe("archive parsing", () => {
  it("parses funding CSV with header and snaps drifting timestamps to the hour", () => {
    const csv = "calc_time,funding_interval_hours,last_funding_rate\n1654041600000,8,0.00010000\n1654070400011,8,-0.00002\n";
    const rows = parseFundingCsv("ETHUSDT", csv);
    expect(rows).toEqual([
      { symbol: "ETHUSDT", fundingTime: 1654041600000, intervalHours: 8, rate: 0.0001 },
      { symbol: "ETHUSDT", fundingTime: 1654070400000, intervalHours: 8, rate: -0.00002 },
    ]);
  });

  it("parses kline CSV with or without header, and microsecond timestamps", () => {
    const withHeader = "open_time,open,high,low,close,volume,close_time,quote_volume,count,a,b,c\n1704067200000,1,2,0.5,1.5,10,1704070799999,15,1,0,0,0\n";
    const noHeader = "1748736000000000,1,2,0.5,1.5,10,1748739599999999,15,1,0,0,0\n";
    expect(parseKlineCsv("perp", "X", withHeader)[0]).toMatchObject({ openTime: 1704067200000, high: 2, close: 1.5, quoteVolume: 15 });
    expect(parseKlineCsv("spot", "X", noHeader)[0]).toMatchObject({ openTime: 1748736000000, close: 1.5 });
  });

  it("normalizes timestamps", () => {
    expect(toMs(1748736000000000)).toBe(1748736000000);
    expect(snapHour(1654070399990)).toBe(1654070400000);
  });

  it("infers REST funding intervals from gaps", () => {
    const H = 3_600_000;
    const rows = fromRawFunding(
      [
        { symbol: "X", fundingTime: 8 * H, fundingRate: "0.0001" },
        { symbol: "X", fundingTime: 12 * H, fundingRate: "0.0002" },
        { symbol: "X", fundingTime: 16 * H + 3, fundingRate: "0.0003" },
      ],
      0,
      8,
    );
    expect(rows.map((r) => r.intervalHours)).toEqual([8, 4, 4]);
  });

  it("builds month ranges across years", () => {
    expect(monthRange("2023-11", "2024-02")).toEqual(["2023-11", "2023-12", "2024-01", "2024-02"]);
  });
});

describe("spot matching", () => {
  const spot = new Set(["BTCUSDT", "PEPEUSDT", "1000CATUSDT", "USDCUSDT"]);
  it("matches plain and scaled perps", () => {
    expect(matchSpot("BTCUSDT", spot)).toEqual({ symbol: "BTCUSDT", base: "BTC", spotSymbol: "BTCUSDT" });
    expect(matchSpot("1000PEPEUSDT", spot)).toEqual({ symbol: "1000PEPEUSDT", base: "PEPE", spotSymbol: "PEPEUSDT" });
    expect(matchSpot("1000CATUSDT", spot)?.spotSymbol).toBe("1000CATUSDT");
  });
  it("rejects stablecoins, non-USDT and unmatched perps", () => {
    expect(matchSpot("USDCUSDT", spot)).toBeNull();
    expect(matchSpot("BTCUSDC", spot)).toBeNull();
    expect(matchSpot("DOGEUSDT", spot)).toBeNull();
  });
});
