/**
 * Utility functions for geolocation
 */

interface GeoCountry {
  countryCode: string;
  countryName: string;
}

/**
 * Get country information based on IP address
 * Uses ipapi.co free service to determine country
 */
export async function getCountryByIp(): Promise<GeoCountry | null> {
  try {
    // console.log('Attempting to get country by IP...');
    // Use ipapi.co which provides a simple API for IP geolocation
    const response = await fetch('https://ipapi.co/json/', {
      headers: {
        'Accept': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.error('Failed to fetch country data:', response.statusText);
      return null;
    }
    
    const data = await response.json();
    // console.log('Geolocation data received:', data);

    if (data.country_code && data.country_name) {
      // console.log('Country detected:', data.country_name, data.country_code);
      return {
        countryCode: data.country_code,
        countryName: data.country_name
      };
    }

    // console.log('No country data found in response');
    return null;
  } catch (error) {
    console.error('Error fetching country by IP:', error);
    return null;
  }
}
