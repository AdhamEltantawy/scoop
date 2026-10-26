// Community features (social.js) use a Supabase project. Leave these empty to
// build Scoop without them. The anon key is meant to be public: row level
// security in supabase/migrations decides what each user can read and write.
// Never put the service_role key here.
window.SCOOP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Where invite links point (the hosted web app). Defaults to the GitHub Pages URL.
  publicUrl: '',
};
