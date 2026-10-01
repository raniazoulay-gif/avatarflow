# Privacy

SafeDrive processes location data of young people. Privacy is a product feature, not an afterthought.

## Principles
1. **Transparency and consent.**
   - A driver joins a family only by accepting an invite and explicitly consenting. The consent version and time are stored.
   - Monitoring runs **only during an active trip** that the driver started or accepted on the phone.
   - The phone always shows that monitoring is on: an in-app banner, the Android persistent notification, and the iOS location indicator.
   - **There is no covert mode.**
2. **Purpose limitation.** Data is used for family safety only: live view, alerts, trip history and the score. No advertising, no selling, no insurance scoring.
3. **Data minimisation.**
   - No location is collected outside trips.
   - No contacts, messages or app usage are read. The OS doesn't allow it, and we don't try.
   - Phone-usage detection is limited to interaction with SafeDrive itself while moving.
4. **Retention** (IL defaults, configurable):
   - raw GPS points: 30 days
   - trip summaries, events and SOS: 365 days (then the whole trip is deleted)
   - audit log: 730 days
   - notifications: 180 days
5. **User rights.**
   - **Delete:** account deletion in-app (`DELETE /me`) erases raw locations and strips coordinates from summaries.
   - **Remove:** parents can remove members.
   - **Stop being monitored:** monitoring only runs while the driver drives with SafeDrive on, so the driver controls it. A self-service "leave family" button is on the roadmap; today a driver leaves by deleting the account.
   - **Export:** data export (access right) is on the roadmap.
6. **Access control.**
   - Only parents of the driver's own family see live data.
   - System admins can see metadata. Viewing a family is audited.
7. **Demo data** is generated, labelled `is_demo`, and never mixed with real data or scores.

## Data inventory
| Data | Source | Purpose | Retention |
|---|---|---|---|
| Email, name, password hash | User | Account | Until deletion |
| Family, roles, invites | Parent | Access control | Until deletion |
| GPS points (lat/lon, speed, heading, accuracy, time) | Driver phone, trip only | Speeding detection, live view, replay | 30 days |
| Trip summary, speeding/safety events | Server | History, score | 365 days |
| SOS (location, speed, time) | Driver | Emergency alert | 365 days |
| Device model, push token, permission status | Phone | Notifications, capability display | Until revoked |
| Audit log (actor, action, IP) | Server | Security | 730 days |

## Minors
Drivers are often 17–18. The country profile holds `minAccountAge` (IL: 16), but it is **not enforced yet**: there is no age check at registration. Whether guardian consent is needed depends on the jurisdiction. See [LEGAL_AND_COMPLIANCE_NOTES.md](LEGAL_AND_COMPLIANCE_NOTES.md).
