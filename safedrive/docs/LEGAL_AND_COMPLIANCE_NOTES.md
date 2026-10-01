# Legal & compliance notes

> These are engineering notes, **not legal advice**. A lawyer qualified in Israeli privacy law (and in each target market) must review them before launch.

## Israel
- **Privacy Protection Law, 5741-1981, and its Amendment 13 (in force August 2025).**
  - Location and driving data of identifiable people is personal data.
  - Expect obligations around: notice and consent, purpose limitation, data security (Privacy Protection (Data Security) Regulations 2017), a database registration or notification where it applies, and data-subject rights (access, correction, deletion).
- **Minors.**
  - Drivers may be 17. Confirm whether a minor's consent is valid alone or whether parental consent is required.
  - The design asks for the driver's own explicit consent *and* is visible by design. Parents cannot monitor covertly.
- **Monitoring of adults.** Covert tracking of another adult may be a criminal offence (for example, under the Privacy Protection Law and the Penal Code's stalking provisions). SafeDrive prevents covert use technically:
  - consent is required
  - monitoring runs only during a trip the driver started or accepted
  - the OS indicators are always on
- **Emergency services.** Do not imply that SafeDrive contacts police, MDA or the fire service. It only shows tap-to-call numbers 100/101/102.
- **Consumer protection.** Pricing and auto-renewal terms are required if the service becomes paid.

## EU / UK (if expanding)
- GDPR / UK GDPR:
  - lawful basis (consent or legitimate interest)
  - DPIA (location data of minors makes this likely required)
  - data processing agreements with processors (hosting, Expo, HERE/TomTom)
  - transfer mechanisms
- Article 8 GDPR: the age of digital consent is 13–16 depending on the member state.

## App stores
- **Google Play:**
  - The Background Location policy requires a prominent in-app disclosure before the permission prompt, the declaration form, and a video.
  - "Stalkerware" policy: the app must show persistent notice to the monitored person and must not hide its icon. SafeDrive meets both.
- **Apple:**
  - App Review Guideline 5.1.1 / 5.1.2 (data collection and use).
  - Purpose strings for "Always" location.
  - Apps for monitoring others must be transparent and consent-based.

## Third-party terms
- OpenStreetMap: ODbL attribution. Public Overpass and tile servers have usage policies (dev only).
- HERE and TomTom: limits on caching duration and on displaying data over third-party maps. Check the contract.
- Waze and Google Maps: SafeDrive uses only public deep links. It does not scrape or use private APIs; both are forbidden by their terms.

## Documents to prepare (Hebrew + English)
- Privacy policy, based on [PRIVACY.md](PRIVACY.md)
- Terms of use, including "not a substitute for responsible driving" and emergency disclaimers
- Driver consent text. The current text is in the app and versioned as `consent_version`.
- Data retention schedule (defaults in [DATABASE.md](DATABASE.md))
- Incident-response and breach-notification procedure
