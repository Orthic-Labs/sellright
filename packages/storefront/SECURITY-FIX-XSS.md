# XSS Security Fix - PCI Compliance

## Summary
This document describes the security enhancements made to address Cross-Site Scripting (XSS) vulnerabilities as identified in PCI DSS compliance scans.

## Date
2025-10-09

## PCI Compliance Issue
**Issue**: Cross-site scripting attacks from occurring
**Severity**: High
**Reference**: PCI DSS Requirement 6.5.7

## Vulnerabilities Identified

### 1. **Unsafe HTML Rendering**
- **Location**: `frontend/src/routes/products/[...slug]/index.tsx:693`
- **Issue**: Product descriptions were rendered using `dangerouslySetInnerHTML` without sanitization
- **Risk**: Malicious HTML/JavaScript could be injected through product descriptions

### 2. **Missing Input Sanitization**
- **Issue**: User inputs not properly validated and escaped
- **Risk**: XSS attacks through form inputs

### 3. **Weak Content Security Policy**
- **Issue**: CSP headers not properly configured
- **Risk**: Inline scripts could execute malicious code

## Fixes Implemented

### 1. HTML Sanitization Library
**Added**: `isomorphic-dompurify` package for robust HTML sanitization

**File**: `frontend/src/utils/sanitize.ts`
```typescript
import DOMPurify from 'isomorphic-dompurify';

export const sanitizeHtml = (dirty: string, options?: DOMPurify.Config): string => {
    // Removes script tags, event handlers, and other XSS vectors
    return DOMPurify.sanitize(dirty, defaultConfig);
};

export const sanitizeProductDescription = (dirty: string): string => {
    // Allows safe HTML formatting in product descriptions
    return sanitizeHtml(dirty, permissiveConfig);
};
```

**Features**:
- Removes all `<script>` tags
- Removes event handlers (`onclick`, `onerror`, etc.)
- Removes dangerous tags (`iframe`, `object`, `embed`, `form`)
- Allows safe HTML formatting tags (`p`, `br`, `strong`, `em`, etc.)
- Protects against DOM-based XSS attacks

### 2. Product Description Sanitization
**File**: `frontend/src/routes/products/[...slug]/index.tsx`

**Before**:
```tsx
<div
    dangerouslySetInnerHTML={product.description}
/>
```

**After**:
```tsx
import { sanitizeProductDescription } from '~/utils/sanitize';

<div
    dangerouslySetInnerHTML={sanitizeProductDescription(product.description || '')}
/>
```

### 3. Enhanced Server Security Headers
**File**: `frontend/src/entry.express.tsx`

Added comprehensive security headers:

#### XSS Protection
```javascript
res.setHeader('X-XSS-Protection', '1; mode=block');
```

#### Clickjacking Protection
```javascript
res.setHeader('X-Frame-Options', 'SAMEORIGIN');
```

#### MIME Type Sniffing Protection
```javascript
res.setHeader('X-Content-Type-Options', 'nosniff');
```

#### Referrer Policy
```javascript
res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
```

#### Permissions Policy
```javascript
res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
```

#### Content Security Policy (CSP)
```javascript
const cspDirectives = [
    `default-src 'self'`,
    `img-src 'self' data: https:`,
    `font-src 'self' data:`,
    `style-src 'self' 'unsafe-inline'`,
    `script-src 'self' 'nonce-${nonce}'`,
    `connect-src 'self' https://demo.vendure.io https://rottenhand.com https://secure.nmi.com ...`,
    `frame-src 'self' https://secure.nmi.com https://gateway.sezzle.com ...`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'self'`,
    `upgrade-insecure-requests`
].join('; ');
```

**Key CSP Features**:
- Uses cryptographic nonces for inline scripts
- Restricts script sources to trusted domains
- Blocks object and embed tags
- Prevents frame injection attacks
- Forces HTTPS upgrades

#### Strict Transport Security (HSTS)
```javascript
// Production only
res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
```

### 4. Input Validation Enhancement
**File**: `frontend/src/utils/validation.ts`

Existing validation utilities ensure:
- Email validation with bogus pattern detection
- Phone number sanitization and validation
- Postal code validation with country-specific rules
- Name and address validation with character restrictions

## Testing

### Manual Testing Checklist
- [x] Product descriptions render safely without scripts
- [x] Security headers are present in HTTP responses
- [x] CSP blocks unauthorized inline scripts
- [x] Form inputs are properly validated
- [x] XSS payloads are sanitized

### Test XSS Payloads
Test these payloads in product descriptions (they should be sanitized):
```html
<script>alert('XSS')</script>
<img src=x onerror="alert('XSS')">
<iframe src="javascript:alert('XSS')"></iframe>
<svg onload="alert('XSS')">
```

### Verify Security Headers
Check HTTP response headers:
```bash
curl -I https://damneddesigns.com
```

Expected headers:
- `X-XSS-Protection: 1; mode=block`
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Content-Security-Policy: ...`
- `Strict-Transport-Security: max-age=31536000` (production)

## Deployment Steps

1. **Install Dependencies**
   ```bash
   cd frontend
   pnpm install
   ```

2. **Build Application**
   ```bash
   pnpm run build
   ```

3. **Restart Server**
   ```bash
   pm2 restart store
   ```

4. **Verify Deployment**
   ```bash
   # Check security headers
   curl -I https://damneddesigns.com

   # Test product pages
   curl https://damneddesigns.com/products/[product-slug]
   ```

## PCI Compliance

### Addressed Requirements
- **PCI DSS 6.5.7**: Cross-Site Scripting (XSS)
- **PCI DSS 6.6**: Web application vulnerabilities

### Defense in Depth
Multiple layers of protection:
1. **Input Validation**: Validate and sanitize all user inputs
2. **Output Encoding**: HTML entities properly escaped
3. **Content Security Policy**: Restrict script execution
4. **HTTP Security Headers**: Additional browser-level protections
5. **HTTPS**: Enforce encrypted connections

## Maintenance

### Regular Security Updates
```bash
# Update security dependencies
pnpm update isomorphic-dompurify

# Check for vulnerabilities
pnpm audit
```

### Code Review Guidelines
- Always use `sanitizeHtml()` for user-generated content
- Never use `dangerouslySetInnerHTML` without sanitization
- Review CSP policy when adding new third-party services
- Test XSS payloads in development

## Additional Resources

- [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- [Content Security Policy Reference](https://content-security-policy.com/)
- [DOMPurify Documentation](https://github.com/cure53/DOMPurify)
- [PCI DSS Requirements](https://www.pcisecuritystandards.org/)

## Support

For security concerns, contact:
- Security Team: [security contact]
- PCI Compliance Officer: [compliance contact]

---

**Document Version**: 1.0
**Last Updated**: 2025-10-09
**Author**: Claude Code (AI Assistant)
