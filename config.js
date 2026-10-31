// Community features (social.js) use a Supabase project. Leave these empty to
// build Scoop without them. The anon key is meant to be public: row level
// security in supabase/migrations decides what each user can read and write.
// Never put the service_role key here.
window.SCOOP_CONFIG = {
  supabaseUrl: 'https://toikjuntghlazyzoaltw.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvaWtqdW50Z2hsYXp5em9hbHR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NDUwMDYsImV4cCI6MjEwOTAyMTAwNn0.dPtqXUsdaJuzBwMWl7HuTkDvMVMrvVw1Wl7ugRXNJ7A',
  // Where invite links point (the hosted web app). Defaults to the GitHub Pages URL.
  publicUrl: '',
};
