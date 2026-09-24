export const HEADER_STYLES = `
  .header-logo {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #fff;
    text-decoration: none;
    min-height: 44px;
  }
  .header-logo-icon {
    flex-shrink: 0;
    display: block;
  }
  .header-logo-text {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 1.05rem;
    letter-spacing: 0.01em;
    color: #fff;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 46vw;
  }
  @media (min-width: 768px) {
    .header-logo-text {
      max-width: 320px;
    }
  }
  .header-nav-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: var(--step--1);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9A9488;
    min-height: 44px;
    display: flex;
    align-items: center;
    transition: color 0.3s ease;
    cursor: pointer;
    text-decoration: none;
  }
  .header-nav-link:hover {
    color: var(--color-accent-hover);
  }
  .header-nav-link.active {
    color: var(--color-accent-hover);
  }
  .header-icon {
    color: #9A9488;
    transition: color 0.3s ease;
    cursor: pointer;
  }
  .header-icon:hover {
    color: var(--color-accent-hover);
  }
  .header-badge {
    position: absolute;
    top: 6px;
    right: 2px;
    width: 16px;
    height: 16px;
    background: var(--color-accent);
    color: #fff;
    font-size: 0.625rem;
    font-weight: 700;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .header-icon-btn {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 10px;
    min-width: 44px;
    min-height: 44px;
  }
  .header-scrolled {
    background: rgba(10, 10, 10, 0.8);
    backdrop-filter: blur(20px) saturate(1.2);
    -webkit-backdrop-filter: blur(20px) saturate(1.2);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
  }

  @keyframes sr-header-solidify {
    from {
      background: transparent;
      backdrop-filter: blur(0) saturate(1);
      -webkit-backdrop-filter: blur(0) saturate(1);
      box-shadow: none;
    }
    to {
      background: rgba(10, 10, 10, 0.8);
      backdrop-filter: blur(20px) saturate(1.2);
      -webkit-backdrop-filter: blur(20px) saturate(1.2);
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05);
    }
  }

  .header-home-transparent {
    background: transparent;
    animation: sr-header-solidify linear both;
    animation-timeline: scroll();
    animation-range: 0px 101px;
  }

  @supports not (animation-timeline: scroll()) {
    .header-home-transparent {
      animation: none;
    }
  }
  .header-user-dropdown {
    background: #1A1A1A;
    border: 1px solid #2A2A28;
  }
  .header-user-dropdown a,
  .header-user-dropdown button {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: var(--step--1);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #9A9488;
    transition: color 0.2s ease, background-color 0.2s ease;
  }
  .header-user-dropdown a:hover,
  .header-user-dropdown button:hover {
    color: var(--color-accent-hover);
    background-color: rgba(255, 255, 255, 0.04);
  }
  .mobile-overlay {
    background: rgba(10, 10, 10, 0.95);
    backdrop-filter: blur(24px) saturate(1.2);
    -webkit-backdrop-filter: blur(24px) saturate(1.2);
  }
  .mobile-nav-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: 1.25rem;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #9A9488;
    min-height: 56px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s ease, background-color 0.2s ease;
    border-radius: 8px;
    padding: 16px 24px;
    text-decoration: none;
  }
  .mobile-nav-link:hover,
  .mobile-nav-link.active {
    color: var(--color-accent-hover);
    background-color: rgba(255, 255, 255, 0.04);
  }
  .mobile-sub-link {
    font-family: var(--font-body);
    font-weight: 500;
    font-size: 1rem;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: #9A9488;
    display: block;
    padding: 12px 24px;
    transition: color 0.2s ease, background-color 0.2s ease;
    border-radius: 8px;
    text-decoration: none;
  }
  .mobile-sub-link:hover {
    color: var(--color-accent-hover);
    background-color: rgba(255, 255, 255, 0.04);
  }
  .burger-btn {
    display: flex;
  }
  @media (min-width: 768px) {
    .burger-btn {
      display: none;
    }
  }
`;
