// Generated client of the mobile app 1.0.0 (swaggie style).
export const petsClient = {
  createPet(body: NewPet): Promise<Pet> {
    const url = "/api/pets";
    return fetch(url, { method: "POST", body: JSON.stringify(body) }).then(
      (response) => response.json() as Promise<Pet>,
    );
  },
};

export interface NewPet {
  name: string;
  nickname: string;
}

export interface Pet {
  id: string;
}
