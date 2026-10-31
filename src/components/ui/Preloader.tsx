import type { ARState } from '../../core/ARManager';

/** The branded preloader from the reference: a hero close-up with a progress bar running across it. */
export function Preloader({ state }: { state: ARState }) {
  const { experience, progress, progressLabel } = state;
  const hero = experience?.hero ?? experience?.thumb;

  return (
    <section className="screen preloader">
      {hero && <img className="preloader__hero" src={hero} alt="" />}
      <div className="preloader__scrim" />
      {experience?.logo ? (
        <img className="brand-logo preloader__logo" src={experience.logo} alt={experience.title} />
      ) : (
        <p className="eyebrow preloader__logo">{experience?.title ?? 'BAY81 Studio'}</p>
      )}
      <p className="preloader__sub">AR experience</p>
      <div className="preloader__bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ transform: `scaleX(${Math.max(0.02, progress)})` }} />
      </div>
      <p className="preloader__label">{progressLabel || 'Preloading'}</p>
    </section>
  );
}
