import { useSession } from './session';

export const SOFTWARE = { name: 'BMS Restaurant', initials: 'BMS', company: 'NEXUS RAJAN S.A.R.L', version: 'v1.1' };
export const LANGUAGES = [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }] as const;
export const THEMES = [
  { code: 'gold', label: 'Gold', swatch: '#8f6c1d' },
  { code: 'navy', label: 'Navy', swatch: '#1e3a8a' },
  { code: 'emerald', label: 'Emerald', swatch: '#065f46' },
  { code: 'crimson', label: 'Crimson', swatch: '#991b1b' },
  { code: 'slate', label: 'Slate', swatch: '#0f172a' },
] as const;

// English is the source text; missing keys fall back to English.
// shortcut: covers the shell, navigation, dashboard and profile only; extend FR when other screens need it.
const FR: Record<string, string> = {
  Dashboard: 'Tableau de bord', POS: 'Point de vente', 'POS Terminal': 'Terminal de caisse', 'Floor Plan': 'Plan de salle',
  'Kitchen Display': 'Écran cuisine', Reservations: 'Réservations', 'Orders / Tickets': 'Commandes / Tickets', 'Delivery & Commissions': 'Livraison & Commissions',
  'Delivery Partners': 'Partenaires de livraison', Zones: 'Zones', 'Commission Rules': 'Règles de commission',
  'Commission Report': 'Rapport des commissions', 'Grouped Deliveries': 'Livraisons groupées', 'Recipes & Inventory': 'Recettes & Stock',
  Ingredients: 'Ingrédients', 'Branch Stock': 'Stock du site', Recipes: 'Recettes', 'Stock Ledger': 'Mouvements de stock',
  'Low Stock Alerts': 'Alertes de stock bas', 'Waste Management': 'Gestion des pertes', 'Exchange Rates': 'Taux de change',
  'Counter Expenses': 'Dépenses de caisse', Expenses: 'Dépenses', Categories: 'Catégories', Reports: 'Rapports',
  'X Report': 'Rapport X', 'Z Report (close day)': 'Rapport Z (clôture)', 'X/Z History': 'Historique X/Z',
  'Monthly Consolidated': 'Consolidé mensuel', 'Staff Activity': 'Activité du personnel',
  'Settlement-wise Receipts': 'Encaissements par mode de règlement', 'Item-wise Sales': 'Ventes par article', Menu: 'Menu', 'Menu Overview & Prices': 'Aperçu du menu & prix',
  'Items, Sizes & Prices': 'Articles, tailles & prix', Modifiers: 'Suppléments', 'Cooking Notes': 'Notes de cuisson', 'Kitchens & Bars': 'Cuisines & Bars', Clients: 'Clients', 'Client List': 'Liste des clients',
  Coupons: 'Coupons', Settings: 'Paramètres', Companies: 'Sociétés', Branches: 'Sites', Users: 'Utilisateurs',
  'Roles & Permissions': 'Rôles & Permissions', 'Devices / Terminals': 'Appareils / Terminaux', 'Printers (KOT)': 'Imprimantes (KOT)',
  'Backup & Restore': 'Sauvegarde & Restauration',
  Registers: 'Caisses', 'Payment Methods': 'Moyens de paiement', 'Receipt Channels': 'Canaux de vente', 'Print Queue': "File d'impression",
  'Expand all': 'Tout déplier', 'Collapse all': 'Tout replier', 'Hide menu': 'Masquer le menu', 'Show menu': 'Afficher le menu',
  'My profile': 'Mon profil', 'About the Software': 'À propos du logiciel', 'Sign out': 'Déconnexion', Theme: 'Thème', Language: 'Langue',
  'Good morning': 'Bonjour', 'Good afternoon': 'Bon après-midi', 'Good evening': 'Bonsoir', 'Business overview': "Vue d'ensemble",
  From: 'Du', To: 'Au', Branch: 'Site', 'All branches': 'Tous les sites', 'This Month': 'Ce mois', 'Last Month': 'Mois dernier',
  Sales: 'Ventes', 'Net receipts': 'Encaissements nets', 'Net cash': 'Espèces nettes', 'Owed by clients': 'Dû par les clients',
  Refunds: 'Remboursements', Discounts: 'Remises', 'days recorded': 'jours enregistrés', tickets: 'tickets',
  'Daily sales trend': 'Évolution des ventes', 'Sales by branch': 'Ventes par site', 'Low stock alerts': 'Alertes de stock bas',
  'Open POS terminal': 'Ouvrir la caisse', 'Online ordering page': 'Page de commande en ligne',
  Position: 'Poste', 'Landing page after sign-in': "Page d'accueil après connexion", 'Automatic (by role)': 'Automatique (selon le rôle)',
  'Home / dashboard': 'Accueil / tableau de bord', 'POS terminal': 'Caisse (POS)', 'Kitchen display': 'Écran cuisine', 'Orders / tickets': 'Commandes / tickets', 'Change password': 'Changer le mot de passe', 'Current password': 'Mot de passe actuel',
  'New password': 'Nouveau mot de passe', 'Confirm new password': 'Confirmer le mot de passe', Save: 'Enregistrer',
  'Change PIN': 'Changer le PIN', 'New 4-digit PIN': 'Nouveau PIN (4 chiffres)', Preferences: 'Préférences', Role: 'Rôle', Username: "Nom d'utilisateur",
  'Saved': 'Enregistré', 'Passwords do not match': 'Les mots de passe ne correspondent pas', 'No data in this period': 'Aucune donnée sur cette période',
  'Mixed currencies: totals add amounts in different currencies.': 'Devises mixtes : les totaux additionnent des montants de devises différentes.',
};

export function useT() {
  const { me } = useSession();
  const lang = me?.user?.language ?? localStorage.getItem('bms:lang') ?? 'en';
  return (s: string) => (lang === 'fr' ? FR[s] ?? s : s);
}
