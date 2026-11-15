/**
 * This portal's configuration: Muntinlupa City.
 * What each field means: src/config.ts. Check it against the live API with
 * `npm run check`.
 *
 * Muntinlupa has no DPWH office of its own. It shares the Las Piñas-Muntinlupa
 * District Engineering Office with Las Piñas, so that office's figures are
 * shown whole, never split. The place name brings in lines from all four
 * programs whose title names Muntinlupa.
 */
import { defineConfig } from './src/config';

export default defineConfig({
  id: 'muntinlupa-city',
  kind: 'city',
  name: 'Muntinlupa City',
  shortName: 'Muntinlupa',
  // A citizen project. It is not run by the city government.
  operator: { name: 'citizen volunteers, not the city government', url: 'https://github.com/AndrewConcejero/MuntinlupaTransparencyPortal' },
  scope: {
    offices: ['Las Piñas Muntinlupa District Engineering Office'],
    places: [{ label: 'Muntinlupa', region: 'NCR' }],
    // Muntinlupa's nine barangays. A project is listed under each one its title names.
    barangays: [
      { name: 'Alabang' },
      { name: 'Ayala Alabang', aliases: ['New Alabang Village', 'New Alabang'] },
      { name: 'Bayanan' },
      { name: 'Buli' },
      { name: 'Cupang' },
      { name: 'Poblacion' },
      { name: 'Putatan' },
      { name: 'Sucat' },
      { name: 'Tunasan' },
    ],
    // The DPWH office is shared with Las Piñas; its projects there are grouped apart.
    // ("Las Pias" catches the ñ some older documents lost.)
    neighbours: [{ label: 'Las Piñas', names: ['Las Piñas', 'Las Pias'] }],
    districts: ['leg:muntinlupa-city:lone'],
    // Namesakes: other places called Muntinlupa. Published on the About page.
    exclude: [
      {
        key: 'gaa:18-001|construction of muntinlupa public market poblacion salug zamboanga del norte phase 2',
        reason: 'This Muntinlupa is a barangay of Salug, Zamboanga del Norte, not Muntinlupa City.',
      },
      {
        key: 'gaa:18-001|rehabilitation of quirino highwaymuntinlupa parang road tagkawayan quezon',
        reason: 'This road is in Tagkawayan, Quezon province, not Muntinlupa City.',
      },
    ],
  },
  reporting: { enabled: false },
});
