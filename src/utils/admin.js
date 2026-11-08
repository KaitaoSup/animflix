import { isAdminUser } from '../../database.js';

/**
 * Garde des routes d'administration : 401 sans session, 403 pour un compte non administrateur.
 * Retourne true si la requête peut continuer.
 */
export function requireAdmin(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Connectez-vous avec le compte administrateur d'Animflix." });
    return false;
  }
  if (!isAdminUser(req.user)) {
    res.status(403).json({ error: "Réservé à l'administrateur du serveur." });
    return false;
  }
  return true;
}
