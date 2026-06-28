import type { DocumentHead } from '@qwik.dev/router';
import type { JsonLdSchema } from '~/types/seo.types';

/**
 * Safely escape JSON content for injection into script tags
 * Prevents XSS attacks and ensures valid JSON-LD
 */
export const escapeJsonForScript = (obj: any): string => {
  try {
    const jsonString = JSON.stringify(obj, null, 0);
    
    // Escape potentially dangerous characters for HTML context
    return jsonString
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/'/g, '\\u0027')
      .replace(/"/g, '\\"');
  } catch (error) {
    console.warn('Failed to serialize JSON-LD schema:', error);
    return '{}';
  }
};

/**
 * Validate JSON-LD schema structure
 * Ensures required properties are present
 */
export const validateJsonLdSchema = (schema: any): schema is JsonLdSchema => {
  if (!schema || typeof schema !== 'object') {
    return false;
  }

  // Check for required JSON-LD properties
  if (!schema['@context'] || !schema['@type']) {
    console.warn('Invalid JSON-LD schema: missing @context or @type', schema);
    return false;
  }

  // Validate @context
  if (typeof schema['@context'] !== 'string' || !schema['@context'].includes('schema.org')) {
    console.warn('Invalid JSON-LD @context:', schema['@context']);
    return false;
  }

  // Validate @type
  if (typeof schema['@type'] !== 'string' || schema['@type'].length === 0) {
    console.warn('Invalid JSON-LD @type:', schema['@type']);
    return false;
  }

  return true;
};

/**
 * Create a meta tag object for JSON-LD injection into DocumentHead
 * Compatible with Qwik 2.0 DocumentHead pattern
 * Uses meta tags instead of script tags for better Qwik compatibility
 */
export const createJsonLdMeta = (schema: JsonLdSchema, index: number = 0): { name: string; content: string } => {
  if (!validateJsonLdSchema(schema)) {
    console.warn('Skipping invalid JSON-LD schema injection');
    return {
      name: `json-ld-${index}`,
      content: '{}'
    };
  }

  try {
    // Serialize as clean JSON for script type="application/ld+json" injection
    // Only escape </script> to prevent premature tag closing (XSS prevention)
    const jsonString = JSON.stringify(schema, null, 0)
      .replace(/<\/script/gi, '<\\/script');
    return {
      name: `json-ld-${schema['@type'].toLowerCase()}-${index}`,
      content: jsonString
    };
  } catch (error) {
    console.warn('Failed to serialize JSON-LD schema:', error);
    return {
      name: `json-ld-${index}`,
      content: '{}'
    };
  }
};

/**
 * Inject multiple JSON-LD schemas into DocumentHead
 * Returns an array of meta objects for the DocumentHead.meta property
 */
export const injectJsonLdSchemas = (schemas: JsonLdSchema[]): Array<{ name: string; content: string }> => {
  if (!Array.isArray(schemas) || schemas.length === 0) {
    return [];
  }

  return schemas
    .filter(schema => validateJsonLdSchema(schema))
    .map((schema, index) => createJsonLdMeta(schema, index));
};

/**
 * Merge JSON-LD meta tags with existing DocumentHead meta
 * Ensures compatibility with existing head configuration
 */
export const mergeJsonLdWithHead = (
  existingHead: any,
  schemas: JsonLdSchema[]
): DocumentHead => {
  const jsonLdMetas = injectJsonLdSchemas(schemas);

  if (jsonLdMetas.length === 0) {
    return existingHead;
  }

  return {
    ...existingHead,
    meta: [
      ...(existingHead.meta || []),
      ...jsonLdMetas
    ]
  };
};

/**
 * Create a complete DocumentHead with JSON-LD schemas
 * Utility function for route head exports
 */
export const createHeadWithSchemas = (
  baseHead: any,
  schemas: JsonLdSchema[]
): DocumentHead => {
  const jsonLdMetas = injectJsonLdSchemas(schemas);

  return {
    ...baseHead,
    meta: [
      ...(baseHead.meta || []),
      ...jsonLdMetas
    ]
  };
};

/**
 * Development helper: Log JSON-LD schemas for debugging
 * Only logs in development mode
 */
export const debugJsonLdSchemas = (schemas: JsonLdSchema[], context: string = 'Unknown'): void => {
  if (import.meta.env.DEV && schemas.length > 0) {
    console.group(`🔍 JSON-LD Schemas (${context})`);
    schemas.forEach((schema, index) => {
      console.log('Schema:', index + 1, schema['@type'], schema);
    });
    console.groupEnd();
  }
};

/**
 * Extract schema type from JSON-LD schema for categorization
 */
export const getSchemaType = (schema: JsonLdSchema): string => {
  return schema['@type'] || 'Unknown';
};

/**
 * Group schemas by type for better organization
 */
export const groupSchemasByType = (schemas: JsonLdSchema[]): Record<string, JsonLdSchema[]> => {
  return schemas.reduce((groups, schema) => {
    const type = getSchemaType(schema);
    if (!groups[type]) {
      groups[type] = [];
    }
    groups[type].push(schema);
    return groups;
  }, {} as Record<string, JsonLdSchema[]>);
};

/**
 * Sanitize schema data to prevent potential security issues
 * Removes potentially dangerous properties and validates data types
 */
export const sanitizeSchema = (schema: any): JsonLdSchema | null => {
  if (!validateJsonLdSchema(schema)) {
    return null;
  }

  // Create a clean copy with only safe properties
  const sanitized: JsonLdSchema = {
    '@context': schema['@context'],
    '@type': schema['@type']
  };

  // Copy other properties with basic sanitization
  Object.keys(schema).forEach(key => {
    if (key.startsWith('@')) return; // Already handled above
    
    const value = schema[key];
    
    // Skip functions and undefined values
    if (typeof value === 'function' || value === undefined) {
      return;
    }
    
    // Recursively sanitize objects
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        sanitized[key] = value.filter(item => item !== null && item !== undefined);
      } else {
        sanitized[key] = value;
      }
    } else {
      sanitized[key] = value;
    }
  });

  return sanitized;
};
