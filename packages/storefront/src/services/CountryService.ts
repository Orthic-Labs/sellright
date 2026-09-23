import countriesData from '../data/countries.json';

interface Country {
  id: string;
  name: string;
  code: string;
}

export class CountryService {
  private static countries: Country[] | null = null;
  
  /**
   * Get all available countries from static JSON data
   * This replaces the GraphQL availableCountries query
   */
  static async getAvailableCountries(): Promise<Country[]> {
    // Return cached countries if already loaded
    if (this.countries) {
      return this.countries;
    }
    
    try {
      // Load countries from static JSON file
      this.countries = countriesData as Country[];
      return this.countries;
    } catch (error) {
      console.error('Failed to load countries data:', error);
      // Return empty array as fallback
      return [];
    }
  }
  
  /**
   * Get a specific country by ID
   */
  static async getCountryById(id: string): Promise<Country | null> {
    const countries = await this.getAvailableCountries();
    return countries.find(country => country.id === id) || null;
  }
  
  /**
   * Get a specific country by code
   */
  static async getCountryByCode(code: string): Promise<Country | null> {
    const countries = await this.getAvailableCountries();
    return countries.find(country => country.code === code) || null;
  }
  
  /**
   * Search countries by name (case-insensitive)
   */
  static async searchCountries(query: string): Promise<Country[]> {
    const countries = await this.getAvailableCountries();
    const lowerQuery = query.toLowerCase();
    return countries.filter(country => 
      country.name.toLowerCase().includes(lowerQuery) ||
      country.code.toLowerCase().includes(lowerQuery)
    );
  }
  
  /**
   * Clear cached countries (useful for testing or if data needs refresh)
   */
  static clearCache(): void {
    this.countries = null;
  }
  
  /**
   * Get countries count
   */
  static async getCountriesCount(): Promise<number> {
    const countries = await this.getAvailableCountries();
    return countries.length;
  }
}

export type { Country };