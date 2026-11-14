import Image from 'next/image';

/**
 * Theme-aware DeerDawn mark. Renders both the white-on-dark (`logo-v3-light.png`)
 * and dark-on-light (`logo-v3.png`) deer marks; CSS (.theme-dark-only /
 * .theme-light-only in globals.css) reveals the correct one with no JS, so there
 * is no flash or hydration swap.
 *
 * Drop it inside a `position: relative` sized container (it uses next/image
 * `fill`), replacing a single <Image fill> logo.
 */
export function BrandLogo({
  alt = '',
  sizes,
  priority = false,
  loading,
  className = 'object-contain',
}: {
  alt?: string;
  sizes?: string;
  priority?: boolean;
  /** Ignored when `priority` is set (next/image forbids both). */
  loading?: 'lazy' | 'eager';
  className?: string;
}) {
  // next/image rejects `loading` alongside `priority`; drop it in that case.
  const loadingProp = priority ? {} : { loading };
  return (
    <>
      <Image
        src="/logo-v3-light.png"
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        {...loadingProp}
        className={`${className} theme-dark-only`}
      />
      <Image
        src="/logo-v3.png"
        alt={alt}
        fill
        sizes={sizes}
        priority={priority}
        {...loadingProp}
        className={`${className} theme-light-only`}
      />
    </>
  );
}

export default BrandLogo;
