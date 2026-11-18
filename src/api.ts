import { supabase } from './supabase';

export type Mode = 'driver' | 'passenger';
export type Notify = (text: string, kind?: 'ok' | 'err') => void;

export type Match = {
  id: string;
  trip_id: string;
  request_id: string;
  role: Mode;
  status: 'proposed' | 'accepted' | 'declined' | 'cancelled' | 'completed';
  stage: 'scheduled' | 'driver_en_route' | 'driver_arrived' | 'on_board';
  proposed_by_me: boolean;
  other_id: string;
  other_name: string;
  other_rating: number | null;
  other_reviews: number;
  reviewed_by_me: boolean;
  other_phone: string | null;
  pickup_label: string;
  dropoff_label: string;
  trip_origin_label: string;
  trip_dest_label: string;
  meet_at: string;
  cost_share_cents: number;
  seats: number;
  note: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  vehicle_plate: string | null;
  updated_at: string;
  ride_minutes: number | null;
};

export type Listing = {
  id: string;
  origin_label: string;
  dest_label: string;
  window_start: string;
  window_end: string;
  seats?: number;
  seats_taken?: number;
  note?: string | null;
  status?: string;
  cost_share_cents?: number;
};

export type Candidate = {
  trip_id: string;
  request_id: string;
  user_id: string;
  name: string;
  rating: number | null;
  reviews: number;
  origin_label: string;
  dest_label: string;
  overlap_start: string;
  pickup_m: number;
  shared_km: number;
  seats_left?: number;
  cost_share_cents?: number;
  seats?: number;
  note?: string | null;
};

export type Review = {
  id: number;
  rating: number;
  comment: string | null;
  created_at: string;
  author_id: string;
  author: { display_name: string } | null;
};

export type PublicProfile = { display_name: string; points: number; created_at: string; badges: string[] };

export type Notification = {
  id: number;
  match_id: string | null;
  role: Mode;
  kind: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
};

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const api = {
  async matches(): Promise<Match[]> {
    const list = (await rpc<Match[]>('my_matches')) ?? [];
    // Durée estimée des trajets confirmés : lue sur la mise en relation elle-même.
    const live = list.filter((m) => m.status === 'accepted').map((m) => m.id);
    if (live.length) {
      const { data } = await supabase.from('matches').select('id,ride_minutes').in('id', live);
      const minutes = new Map((data ?? []).map((r: any) => [r.id, r.ride_minutes]));
      for (const m of list) m.ride_minutes = minutes.get(m.id) ?? null;
    }
    return list;
  },
  propose: (tripId: string, requestId: string) =>
    rpc<string>('propose_match', { p_trip_id: tripId, p_request_id: requestId }),
  respond: (id: string, accept: boolean) => rpc<string>('respond_match', { p_match_id: id, p_accept: accept }),
  advance: (id: string) => rpc<string>('advance_match', { p_match_id: id }),
  cancelMatch: (id: string) => rpc<void>('cancel_match', { p_match_id: id }),
  cancelTrip: (id: string) => rpc<void>('cancel_trip', { p_trip_id: id }),
  cancelRequest: (id: string) => rpc<void>('cancel_request', { p_request_id: id }),
  setPhone: (phone: string) => rpc<void>('set_phone', { p_phone: phone }),
  setVehicle: (model: string, color: string, plate: string) =>
    rpc<void>('set_vehicle', { p_model: model, p_color: color, p_plate: plate }),
  markRead: () => rpc<void>('mark_notifications_read'),
  setEmailEnabled: (on: boolean) => rpc<void>('set_email_enabled', { p_enabled: on }),
  claim: (matchId: string, category: string, message: string) =>
    rpc<void>('submit_claim', { p_match_id: matchId, p_category: category, p_message: message }),
  review: (matchId: string, rating: number, comment: string) =>
    rpc<void>('submit_review', { p_match_id: matchId, p_rating: rating, p_comment: comment }),

  // Fiche publique d'une personne : jamais de téléphone ni de véhicule ici.
  async publicProfile(userId: string): Promise<PublicProfile | null> {
    const [p, b] = await Promise.all([
      supabase.from('profiles').select('display_name,points,created_at').eq('id', userId).maybeSingle(),
      supabase.from('user_badges').select('badges(label)').eq('user_id', userId),
    ]);
    if (!p.data) return null;
    return { ...p.data, badges: (b.data ?? []).map((r: any) => r.badges?.label).filter(Boolean) };
  },

  async reviews(userId: string): Promise<Review[]> {
    const { data, error } = await supabase
      .from('reviews')
      .select('id,rating,comment,created_at,author_id,author:profiles!reviews_author_id_fkey(display_name)')
      .eq('target_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Review[];
  },

  async notifications(): Promise<Notification[]> {
    const { data, error } = await supabase
      .from('notifications')
      .select('id,match_id,role,kind,title,body,read_at,created_at')
      .order('created_at', { ascending: false })
      .limit(60);
    if (error) throw new Error(error.message);
    return (data ?? []) as Notification[];
  },

  // Mes annonces en cours (trajets en mode conducteur, recherches en mode passager).
  // Une recherche déjà acceptée reste listée : c'est le « dossier » qui porte le trajet confirmé.
  async listings(mode: Mode, uid: string): Promise<Listing[]> {
    const q =
      mode === 'driver'
        ? supabase
            .from('trips')
            .select('id,origin_label,dest_label,window_start,window_end,seats,seats_taken,status,cost_share_cents')
            .eq('driver_id', uid)
            .in('status', ['open', 'full'])
        : supabase
            .from('requests')
            .select('id,origin_label,dest_label,window_start,window_end,seats,note')
            .eq('passenger_id', uid)
            .in('status', ['open', 'matched']);
    const { data, error } = await q.order('window_start', { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Listing[]).reverse();
  },

  async candidates(mode: Mode, listingId: string): Promise<Candidate[]> {
    if (mode === 'driver') {
      const rows = await rpc<any[]>('find_requests_for_trip', { p_trip_id: listingId, p_radius_m: 1000 });
      return (rows ?? []).map((r) => ({ ...r, trip_id: listingId, name: r.passenger_name }));
    }
    const rows = await rpc<any[]>('find_trips_for_request', { p_request_id: listingId, p_radius_m: 1000 });
    return (rows ?? []).map((r) => ({ ...r, request_id: listingId, name: r.driver_name }));
  },
};
