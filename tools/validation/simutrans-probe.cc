// Validation adapter: links the external, unmodified Simutrans sources.
// Initialization/cleanup sequencing below mirrors simworld.cc; this is not a game runtime.
#include "dataobj/height_map_loader.h"
#include "descriptor/ground_desc.h"
#include "world/surface.h"
#include "simdebug.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <vector>

sint8 env_t::pak_height_conversion_factor = 1;
bool ground_desc_t::double_grounds = false;
log_t::level_t debuglevel = log_t::LEVEL_WARN;
log_t probe_log(nullptr, false, false, true, "heightmap validation");
log_t* dbg = &probe_log;
FILE* dr_fopen(const char* filename, const char* mode) { return fopen(filename, mode); }

class probe_surface_t : public surface_t {
  std::vector<sint8> owned;
public:
  probe_surface_t(int w, int h, const sint8* field) : owned((w+1)*(h+1)) {
    cached_grid_size = koord(w,h);
    cached_size = koord(w-1,h-1);
    grid_hgts = owned.data();
    for(int y=0;y<h;y++) {
      for(int x=0;x<w;x++) owned[x+y*(w+1)] = field[x+y*w]+1;
      owned[w+y*(w+1)] = owned[w-1+y*(w+1)];
    }
    for(int x=0;x<=w;x++) owned[x+h*(w+1)] = owned[x+(h-1)*(w+1)];
  }
  void cleanup_heights() {
    const auto snapshot = owned;
    for(int y=0;y<=get_size().y;y++)
      for(int x=0;x<=get_size().x;x++)
        raise_grid_to(x,y,snapshot[x+y*(get_size().x+1)]+1);
    for(auto& value:owned) --value;
  }
  const std::vector<sint8>& heights() const { return owned; }
};

void print_array(const char* name, const sint8* values, size_t size) {
  printf("\"%s\":[",name);
  for(size_t i=0;i<size;i++) printf("%s%d",i?",":"",int(values[i]));
  printf("]");
}

int main(int argc,char** argv) {
  if(argc!=7) { fprintf(stderr,"usage: probe image mode factor double min max\n"); return 2; }
  const int mode=atoi(argv[2]);
  if(mode<0 || mode>3) return 2;
  env_t::pak_height_conversion_factor=atoi(argv[3]);
  ground_desc_t::double_grounds=atoi(argv[4])!=0;
  height_map_loader_t loader(atoi(argv[5]),atoi(argv[6]),static_cast<env_t::height_conversion_mode>(mode));
  sint8* field=nullptr;
  sint16 w=0,h=0;
  if(!loader.get_height_data_from_file(argv[1],-2,field,w,h,false)) return 3;
  // Only bounded, generated fixtures reach the native loader in this experiment.
  if(w<1 || h<1 || w>2048 || h>2048) { free(field); return 4; }
  probe_surface_t surface(w,h,field);
  const auto begin=std::chrono::steady_clock::now();
  surface.cleanup_heights();
  const auto elapsed=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-begin).count();
  printf("{\"width\":%d,\"height\":%d,\"cleanupMs\":%.3f,",w,h,elapsed);
  print_array("decoded",field,size_t(w)*h);
  printf(",");
  print_array("grid",surface.heights().data(),surface.heights().size());
  printf("}\n");
  free(field);
}
