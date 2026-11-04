// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CountryPreferenceService } from "./CountryPreferenceService";

const clearCookie = () => { document.cookie = "countryCode=; Path=/; Max-Age=0"; };
afterEach(() => { localStorage.clear(); clearCookie(); });

describe("#425 CountryPreferenceService.getCountry: the country cookie stands in for an unknown preference", () => {
	it("nothing stored and no cookie: the US default", () => {
		expect(CountryPreferenceService.getCountry()).toBe("US");
	});
	it("nothing stored: the countryCode cookie (set by the checkout document or the edge from the visitor country)", () => {
		document.cookie = "countryCode=in; Path=/";
		expect(CountryPreferenceService.getCountry()).toBe("IN");
		expect(CountryPreferenceService.needsGeolocation()).toBe(true);
	});
	it("a geolocated or explicit choice still wins over the cookie", () => {
		document.cookie = "countryCode=IN; Path=/";
		CountryPreferenceService.setCountryFromGeolocation("DE");
		expect(CountryPreferenceService.getCountry()).toBe("DE");
		CountryPreferenceService.setCountry("FR");
		expect(CountryPreferenceService.getCountry()).toBe("FR");
	});
	it("a malformed cookie is ignored", () => {
		document.cookie = "countryCode=<x>; Path=/";
		expect(CountryPreferenceService.getCountry()).toBe("US");
	});
});
